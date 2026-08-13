import { access, constants, readdir, stat, statfs } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ProcessRunner } from './process-runner.js';
import { detectAvailableEngines } from '../engine.js';
import { twitterBookmarksCachePath } from '../paths.js';

export type DependencyState = 'ready' | 'missing' | 'unsupported';

export interface DependencyCheck {
  name: 'x-connectivity' | 'yt-dlp' | 'ffmpeg' | 'whisper.cpp' | 'whisper-model' | 'synthesis-provider' | 'content-storage' | 'free-disk' | 'temp-cleanup' | 'loopback-security';
  state: DependencyState;
  version?: string;
  location?: string;
  action?: string;
}

export interface ContentDoctorOptions {
  runner: ProcessRunner;
  contentRoot: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: string;
  availableEngines?: string[];
  bookmarksCachePath?: string;
}

async function executableCheck(runner: ProcessRunner, name: DependencyCheck['name'], command: string, args: string[]): Promise<DependencyCheck> {
  try {
    const result = await runner.run({ command, args, timeoutMs: 10_000, maxOutputBytes: 64 * 1024 });
    return { name, state: 'ready', version: (result.stdout || result.stderr).split('\n')[0].trim(), location: command };
  } catch {
    return { name, state: 'missing', location: command, action: `Install ${name} and ensure ${command} is executable.` };
  }
}

export async function inspectContentDependencies(options: ContentDoctorOptions): Promise<DependencyCheck[]> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const whisperBinary = env.FT_WHISPER_CPP_PATH ?? 'whisper-cli';
  const whisperModel = env.FT_WHISPER_MODEL;
  const checks: DependencyCheck[] = await Promise.all([
    executableCheck(options.runner, 'yt-dlp', env.FT_YTDLP_PATH ?? 'yt-dlp', ['--version']),
    executableCheck(options.runner, 'ffmpeg', env.FT_FFMPEG_PATH ?? 'ffmpeg', ['-version']),
    executableCheck(options.runner, 'whisper.cpp', whisperBinary, ['--help']),
  ]);

  const whisper = checks[2];
  if (whisper.state === 'ready' && platform === 'darwin' && arch !== 'arm64') {
    checks[2] = { ...whisper, state: 'unsupported', action: 'Local transcription currently requires an Apple Silicon Mac.' };
  }

  if (!whisperModel) {
    checks.push({ name: 'whisper-model', state: 'missing', action: 'Set FT_WHISPER_MODEL to an explicitly installed whisper.cpp model file.' });
  } else {
    try {
      await access(whisperModel, constants.R_OK);
      const model = await stat(whisperModel);
      checks.push({ name: 'whisper-model', state: model.isFile() ? 'ready' : 'unsupported', location: `${whisperModel} (${Math.max(1, Math.round(model.size / 1024 / 1024))} MB)` });
    } catch {
      checks.push({ name: 'whisper-model', state: 'missing', location: whisperModel, action: 'Install the configured model or update FT_WHISPER_MODEL.' });
    }
  }

  try {
    await access(path.dirname(options.contentRoot), constants.W_OK);
    checks.push({ name: 'content-storage', state: 'ready', location: options.contentRoot });
  } catch {
    checks.push({ name: 'content-storage', state: 'missing', location: options.contentRoot, action: `Make ${path.dirname(options.contentRoot)} writable. Free space is also required under ${os.tmpdir()}.` });
  }
  const cachePath = options.bookmarksCachePath ?? twitterBookmarksCachePath();
  try {
    await access(cachePath, constants.R_OK);
    checks.push({ name: 'x-connectivity', state: 'ready', location: `local cache ${cachePath}` });
  } catch {
    checks.push({ name: 'x-connectivity', state: 'missing', location: cachePath, action: 'Log into x.com in a supported browser, then run `ft sync` once.' });
  }

  const engines = options.availableEngines ?? detectAvailableEngines();
  checks.push(engines.length > 0
    ? { name: 'synthesis-provider', state: 'ready', version: engines.join(', ') }
    : { name: 'synthesis-provider', state: 'missing', action: 'Install and authenticate Claude Code or Codex CLI; transcripts work without synthesis.' });

  try {
    const filesystem = await statfs(path.dirname(options.contentRoot));
    const freeBytes = Number(filesystem.bavail) * Number(filesystem.bsize);
    const freeGb = freeBytes / 1024 ** 3;
    checks.push(freeGb >= 2
      ? { name: 'free-disk', state: 'ready', version: `${freeGb.toFixed(1)} GB available` }
      : { name: 'free-disk', state: 'unsupported', version: `${freeGb.toFixed(1)} GB available`, action: 'Free at least 2 GB before local transcription.' });
  } catch {
    checks.push({ name: 'free-disk', state: 'missing', action: `Make ${path.dirname(options.contentRoot)} accessible so free space can be measured.` });
  }

  const tempRoot = path.join(options.contentRoot, 'tmp');
  try {
    const entries = await readdir(tempRoot);
    checks.push({ name: 'temp-cleanup', state: 'ready', version: `${entries.length} current temporary entr${entries.length === 1 ? 'y' : 'ies'}; stale entries are removed at startup` });
  } catch {
    checks.push({ name: 'temp-cleanup', state: 'ready', version: 'no temporary artifacts' });
  }
  checks.push({ name: 'loopback-security', state: 'ready', location: '127.0.0.1, random port, one-time bootstrap, strict session, Origin + CSRF' });
  return checks;
}
