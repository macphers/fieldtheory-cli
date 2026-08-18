import type { Command } from 'commander';
import { contentDatabasePath, contentDir } from '../paths.js';
import { SqlJsContentRepository } from '../content/sqljs-repository.js';
import { inspectContentDependencies } from '../content/doctor.js';
import { NodeProcessRunner } from '../content/process-runner.js';
import { runContentApp } from '../content/app.js';
import { captureManualUrl } from './capture.js';
import { MemoryService } from './service.js';
import { LocalEmbeddingService } from './embeddings.js';

function guarded(action: (...args: any[]) => Promise<void>): (...args: any[]) => Promise<void> {
  return async (...args) => {
    try { await action(...args); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`\n  Memory error: ${message}\n  Run \`ft memory doctor\` for capability-specific recovery.\n\n`);
      process.exitCode = 1;
    }
  };
}

async function withMemory<T>(callback: (memory: MemoryService, repository: SqlJsContentRepository) => Promise<T>): Promise<T> {
  const repository = await SqlJsContentRepository.open(contentDatabasePath());
  try { return await callback(new MemoryService(repository), repository); }
  finally { await repository.close(); }
}

export function registerMemoryCommands(program: Command): void {
  const memory = program.command('memory').description('Capture, understand, connect, and recall your private local memory');

  memory.command('open').description('Open the local second-brain interface').option('--no-sync', 'Use existing local memory without syncing X').option('--no-open', 'Print the authenticated URL without opening a browser').option('--engine <name>', 'Override the synthesis engine').action(guarded(async (options) => {
    await runContentApp({ engine: options.engine, sync: options.sync, open: options.open, onStatus: (message) => process.stderr.write(`  ${message}\n`) });
  }));

  memory.command('add').description('Capture a video, podcast, or article URL now').argument('<url>').action(guarded(async (url) => {
    const result = await withMemory(async (_service, repository) => captureManualUrl(repository, String(url)));
    console.log(`  Captured ${result.kind}: ${result.itemId}`);
    console.log('  Open with `ft memory open`; exact search becomes available as soon as text is ready.');
  }));

  memory.command('search').description('Search sources, transcripts, bookmarks, and Library Markdown').argument('<query>').option('--limit <n>', 'Maximum results', '20').option('--json', 'Print machine-readable JSON').action(guarded(async (query, options) => {
    const hits = await withMemory((service) => service.search(String(query), Number(options.limit)));
    if (options.json) { console.log(JSON.stringify({ data: hits, query }, null, 2)); return; }
    if (hits.length === 0) { console.log('  No matching memory found.'); return; }
    for (const hit of hits) console.log(`  ${hit.title}\n    ${hit.provenance} · ${hit.excerpt.replace(/\s+/g, ' ').slice(0, 220)}${hit.url ? `\n    ${hit.url}` : ''}`);
  }));

  memory.command('ask').description('Ask across saved sources, passages, bookmarks, and notes').argument('<question>').option('--json', 'Print machine-readable JSON').action(guarded(async (question, options) => {
    const result = await withMemory((service) => service.ask(String(question)));
    if (options.json) { console.log(JSON.stringify(result, null, 2)); return; }
    console.log(`\n${result.answer}\n`);
    for (const citation of result.citations) console.log(`  [${citation.provenance}] ${citation.title}${citation.url ? ` — ${citation.url}` : ''}`);
  }));

  memory.command('topics').description('Show recurring topics across processed memory').option('--json').action(guarded(async (options) => {
    const topics = await withMemory((service) => service.topics());
    if (options.json) { console.log(JSON.stringify({ data: topics }, null, 2)); return; }
    for (const topic of topics) console.log(`  ${topic.label} · ${topic.itemCount} memories\n    ${topic.explanation}`);
  }));

  memory.command('report').description('Show local memory, resurfacing, and sync status').option('--json').action(guarded(async (options) => {
    const report = await withMemory(async (service, repository) => ({ ...(await service.status()), activity: await repository.activityReport() }));
    if (options.json) { console.log(JSON.stringify(report, null, 2)); return; }
    console.log(`  ${report.items} processed sources · ${report.documents} Library documents · ${report.activity.totalEvents} private activity events`);
    console.log(`  X sync ${report.sync.paused ? 'paused' : 'enabled'}${report.sync.lastSuccessAt ? ` · last success ${report.sync.lastSuccessAt}` : ''}`);
    console.log(`  Useful-memory trial ${report.activity.habitTrial.met ? 'met' : 'in progress'} · ${report.activity.habitTrial.activeDays} active days`);
  }));

  const sync = memory.command('sync').description('Inspect or control continuous capture');
  sync.command('status').option('--json').action(guarded(async (options) => {
    const status = await withMemory((service) => service.status());
    if (options.json) console.log(JSON.stringify(status.sync, null, 2));
    else console.log(`  Sync is ${status.sync.paused ? 'paused' : 'enabled'}${status.sync.lastSuccessAt ? ` · last success ${status.sync.lastSuccessAt}` : ' · no recorded successful background run yet'}`);
  }));
  for (const [name, paused] of [['pause', true], ['resume', false]] as const) sync.command(name).action(guarded(async () => {
    await withMemory((service) => service.setPaused('sync', paused));
    console.log(`  Continuous capture ${paused ? 'paused' : 'resumed'}.`);
  }));
  sync.command('now').description('Run X sync and discovery when the app opens').action(() => console.log('  Run `ft sync` now, then `ft memory open --no-sync` to process the refreshed local capture.'));

  const backfill = memory.command('backfill').description('Control low-priority historical processing');
  backfill.command('status').action(guarded(async () => console.log(`  Backfill is ${(await withMemory((service) => service.status())).backfill.paused ? 'paused' : 'enabled'}.`)));
  for (const [name, paused] of [['pause', true], ['resume', false]] as const) backfill.command(name).action(guarded(async () => {
    await withMemory((service) => service.setPaused('backfill', paused));
    console.log(`  Historical backfill ${paused ? 'paused' : 'resumed'}.`);
  }));

  const embeddings = memory.command('embeddings').description('Install and manage the optional local semantic model');
  embeddings.command('status').option('--json').action(guarded(async (options) => {
    const status = await withMemory((_service, repository) => new LocalEmbeddingService(repository).status());
    if (options.json) console.log(JSON.stringify(status, null, 2));
    else console.log(`  ${status.installed ? '✓' : '○'} ${status.model} · ${status.dimensions} dimensions${status.generation ? ` · ${(status.generation.coverage * 100).toFixed(0)}% indexed` : ' · no active vector generation'}`);
  }));
  embeddings.command('install').description('Explicitly download the local MiniLM model into Field Theory data storage').action(guarded(async () => {
    console.log('  Installing Xenova/all-MiniLM-L6-v2 for local CPU inference. Source text remains on this machine.');
    const result = await withMemory((_service, repository) => new LocalEmbeddingService(repository).install());
    console.log(`  ✓ Installed ${result.model} (${result.dimensions} dimensions) in ${result.cache}`);
    console.log('  Run `ft memory embeddings rebuild` to create the first immutable vector generation.');
  }));
  embeddings.command('rebuild').description('Build and atomically promote a fresh local vector generation').action(guarded(async () => {
    const result = await withMemory((_service, repository) => new LocalEmbeddingService(repository).rebuild());
    console.log(`  ✓ Promoted vector generation ${result.generationId} with ${result.vectors} memories.`);
  }));
  embeddings.command('cancel').description('Report cancellation state for vector generation').action(() => console.log('  No embedding rebuild is running in this process. Existing keyword and vector generations remain available.'));
  embeddings.command('uninstall').description('Remove the downloaded local model; keyword search remains available').option('--yes', 'Confirm removal').action(guarded(async (options) => {
    if (!options.yes) throw new Error('Confirmation required: rerun `ft memory embeddings uninstall --yes`.');
    await withMemory((_service, repository) => new LocalEmbeddingService(repository).uninstall());
    console.log('  Removed the local embedding model. Exact search and the last vector generation remain available.');
  }));

  memory.command('doctor').description('Report independent second-brain capabilities and exact recovery actions').option('--json').action(guarded(async (options) => {
    const checks = await inspectContentDependencies({ runner: new NodeProcessRunner(), contentRoot: contentDir() });
    const status = await withMemory((service) => service.status());
    const semantic = await withMemory((service) => service.semanticStatus());
    const capabilities = [
      { name: 'existing-memory', ready: status.items > 0 || status.documents > 0, action: 'Run `ft memory add <url>` or `ft sync` to capture a source.' },
      { name: 'manual-article', ready: true, action: 'Public HTTP(S) articles are extracted with DNS/IP and redirect safety checks.' },
      { name: 'x-sync', ready: checks.find((check) => check.name === 'x-connectivity')?.state === 'ready', action: 'Log into x.com in a supported browser, then run `ft sync`.' },
      { name: 'video-captions', ready: checks.find((check) => check.name === 'yt-dlp')?.state === 'ready', action: 'Install yt-dlp; other memory remains usable.' },
      { name: 'local-transcription', ready: ['ffmpeg', 'whisper.cpp', 'whisper-model'].every((name) => checks.find((check) => check.name === name)?.state === 'ready'), action: 'Install ffmpeg + whisper.cpp and set FT_WHISPER_MODEL.' },
      { name: 'synthesis', ready: checks.find((check) => check.name === 'synthesis-provider')?.state === 'ready', action: 'Install/authenticate a supported model CLI; transcripts and exact search remain available.' },
      { name: 'semantic-search', ready: semantic.ready, action: semantic.installed ? `Local model installed; ${(semantic.coverage * 100).toFixed(0)}% of processed sources are in the active vector generation.` : 'Run `ft memory embeddings install`, then `ft memory embeddings rebuild`; exact cross-corpus search remains available.' },
      { name: 'loopback-security', ready: true, action: 'Bound to 127.0.0.1 with one-time bootstrap, session, Origin, and CSRF checks.' },
    ];
    if (options.json) { console.log(JSON.stringify({ capabilities, checks }, null, 2)); return; }
    for (const capability of capabilities) console.log(`  ${capability.ready ? '✓' : '○'} ${capability.name}: ${capability.ready ? 'ready' : 'optional/unavailable'}\n    ${capability.action}`);
  }));

  memory.command('verify').description('Verify the local memory store without modifying sources').option('--json').action(guarded(async (options) => {
    const result = await withMemory(async (service, repository) => {
      const status = await service.status();
      const today = await service.today(3);
      const jobs = await repository.listJobs();
      return { ok: true, status, today: today.length, jobs: { total: jobs.length, failed: jobs.filter((job) => ['failed', 'blocked'].includes(job.state)).length } };
    });
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else console.log(`  ✓ Store readable · ${result.status.items} sources · ${result.status.documents} documents · ${result.today} Today cards · ${result.jobs.failed} jobs need attention`);
  }));
}
