import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { BookmarkRecord } from '../types.js';
import { readJsonLines } from '../fs.js';
import { syncBookmarksGraphQL } from '../graphql-bookmarks.js';
import { detectAvailableEngines, resolveEngine } from '../engine.js';
import { contentDatabasePath, contentDir, contentTempDir, twitterBookmarksCachePath } from '../paths.js';
import { loadPreferences } from '../preferences.js';
import { DurableJobWorker } from '../jobs/worker.js';
import { GroundedChatService } from './chat/service.js';
import { EngineContentModel } from './engine-model.js';
import { ContentOrchestrator } from './orchestrator.js';
import { NodeProcessRunner } from './process-runner.js';
import { SqlJsContentRepository } from './sqljs-repository.js';
import { TranscriptFallbackPipeline } from './transcripts/fallback.js';
import { WhisperCppTranscriptProvider } from './transcripts/whisper-cpp.js';
import { YtDlpTranscriptProvider } from './transcripts/yt-dlp.js';
import { startContentServer, type RunningContentServer } from '../server/http.js';
import { cleanupOrphanedTempFiles } from './temp-cleanup.js';

export interface ContentAppOptions {
  engine?: string;
  sync?: boolean;
  open?: boolean;
  pollMs?: number;
  env?: NodeJS.ProcessEnv;
  onStatus?: (message: string) => void;
  syncBookmarks?: typeof syncBookmarksGraphQL;
  openBrowser?: (url: string) => void;
  shutdownTimeoutMs?: number;
}

export interface RunningContentApp {
  origin: string;
  bootstrapUrl: string;
  close(): Promise<void>;
}

async function settleAppWork(work: Promise<unknown>[], deadline: number, onTimeout: () => void): Promise<void> {
  const timeoutMs = Math.max(0, deadline - Date.now());
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(() => { onTimeout(); resolve(); }, timeoutMs);
  });
  await Promise.race([Promise.allSettled(work).then(() => undefined), timeout]);
  if (timer) clearTimeout(timer);
}

export function openSystemBrowser(url: string, platform: NodeJS.Platform = process.platform): void {
  const command = platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = platform === 'win32' ? ['/c', 'start', '', url] : [url];
  const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => { /* The printed URL remains the fallback. */ });
  child.unref();
}

async function optionalModel(engine: string | undefined, onStatus: (message: string) => void): Promise<EngineContentModel | undefined> {
  try {
    if (engine) return new EngineContentModel(await resolveEngine({ override: engine }));
    const available = detectAvailableEngines();
    const saved = loadPreferences().defaultEngine;
    const selected = saved && available.includes(saved) ? saved : available[0];
    if (!selected) throw new Error('No supported LLM CLI found.');
    return new EngineContentModel(await resolveEngine({ override: selected }));
  } catch (error) {
    if (engine) throw error;
    onStatus(`Model unavailable; transcripts remain usable (${error instanceof Error ? error.message.split('\n')[0] : String(error)}).`);
    return undefined;
  }
}

export async function startContentApp(options: ContentAppOptions = {}): Promise<RunningContentApp> {
  const env = options.env ?? process.env;
  const onStatus = options.onStatus ?? (() => undefined);
  const runner = new NodeProcessRunner();
  const repository = await SqlJsContentRepository.open(contentDatabasePath());
  let server: RunningContentServer | undefined;
  let timer: NodeJS.Timeout | undefined;
  let workerPromise: Promise<void> = Promise.resolve();
  let syncPromise: Promise<void> = Promise.resolve();
  const syncController = new AbortController();
  let closing = false;

  try {
    const cleanup = await cleanupOrphanedTempFiles(contentTempDir());
    if (cleanup.removed > 0) onStatus(`Removed ${cleanup.removed} stale temporary transcription artifact${cleanup.removed === 1 ? '' : 's'}.`);
    const model = await optionalModel(options.engine, onStatus);
    const ytDlpBinary = env.FT_YTDLP_PATH ?? 'yt-dlp';
    const captionProvider = new YtDlpTranscriptProvider({ runner, binary: ytDlpBinary });
    const whisperProvider = new WhisperCppTranscriptProvider({
      runner,
      binary: env.FT_WHISPER_CPP_PATH ?? 'whisper-cli',
      modelPath: env.FT_WHISPER_MODEL ?? '',
    });
    const transcriptPipeline = new TranscriptFallbackPipeline({
      runner,
      captionProvider,
      whisperProvider,
      contentRoot: contentDir(),
      tempRoot: contentTempDir(),
      ytDlpBinary,
    });
    const orchestrator = new ContentOrchestrator({ repository, metadataProvider: captionProvider, transcriptPipeline, model });
    const worker = new DurableJobWorker({ repository, workerId: `app-${process.pid}-${randomUUID()}`, handlers: orchestrator.handlers() });

    const discoverCached = async (): Promise<void> => {
      const bookmarks = await readJsonLines<BookmarkRecord>(twitterBookmarksCachePath());
      const result = await orchestrator.discover(bookmarks);
      onStatus(`Knowledge library: ${result.discovered} YouTube item${result.discovered === 1 ? '' : 's'} discovered.`);
    };
    await discoverCached();

    const drainWorker = async (): Promise<void> => {
      if (closing) return;
      try {
        while (!closing && await worker.runOnce()) { /* drain ready work serially */ }
      } catch (error) {
        onStatus(`Worker paused: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    const poll = (): void => {
      if (closing) return;
      workerPromise = workerPromise.then(drainWorker);
    };
    poll();
    timer = setInterval(poll, Math.max(250, options.pollMs ?? 1_000));
    timer.unref();

    server = await startContentServer({
      repository,
      ...(model ? { chat: new GroundedChatService(repository, model) } : {}),
      cancelJob: async (jobId) => {
        if (worker.currentJob()?.id !== jobId) throw new Error('The job is no longer running on this worker.');
        worker.cancelCurrent();
      },
    });

    if (options.sync !== false) {
      const sync = options.syncBookmarks ?? syncBookmarksGraphQL;
      syncPromise = sync({
        incremental: true,
        maxMinutes: 5,
        signal: syncController.signal,
        onProgress: (progress) => onStatus(progress.stopReason ?? `Bookmark sync: page ${progress.page}, ${progress.newAdded} added.`),
      })
        .then(async (result) => {
          if (closing) return;
          onStatus(`Bookmark sync complete: ${result.added} added.`);
          await discoverCached();
          poll();
        })
        .catch((error) => { onStatus(`Bookmark sync unavailable; using local cache (${error instanceof Error ? error.message : String(error)}).`); });
    }

    if (options.open !== false) (options.openBrowser ?? openSystemBrowser)(server.bootstrapUrl);
    const activeServer = server;
    return {
      origin: activeServer.origin,
      bootstrapUrl: activeServer.bootstrapUrl,
      close: async () => {
        if (closing) return;
        closing = true;
        if (timer) clearInterval(timer);
        syncController.abort(new Error('Field Theory app is shutting down.'));
        worker.stop();
        const deadline = Date.now() + (options.shutdownTimeoutMs ?? 5_000);
        await settleAppWork([workerPromise, syncPromise], deadline, () => onStatus('Shutdown deadline reached; closing local resources.'));
        await settleAppWork([activeServer.close(), repository.close()], deadline, () => onStatus('Shutdown deadline reached while closing local resources.'));
      },
    };
  } catch (error) {
    closing = true;
    if (timer) clearInterval(timer);
    syncController.abort(new Error('Field Theory app failed to start.'));
    const deadline = Date.now() + (options.shutdownTimeoutMs ?? 5_000);
    await settleAppWork([workerPromise, syncPromise], deadline, () => onStatus('Startup cleanup deadline reached; closing local resources.'));
    await settleAppWork([
      ...(server ? [server.close().catch(() => undefined)] : []),
      repository.close().catch(() => undefined),
    ], deadline, () => onStatus('Startup cleanup deadline reached while closing local resources.'));
    throw error;
  }
}

export async function runContentApp(options: ContentAppOptions = {}): Promise<void> {
  const app = await startContentApp(options);
  const onStatus = options.onStatus ?? ((message: string) => process.stderr.write(`  ${message}\n`));
  onStatus(`Field Theory is running at ${app.origin}`);
  if (options.open === false) onStatus(`Open once: ${app.bootstrapUrl}`);

  await new Promise<void>((resolve) => {
    let stopping = false;
    const stop = (): void => {
      if (stopping) return;
      stopping = true;
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
      void app.close().finally(resolve);
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}
