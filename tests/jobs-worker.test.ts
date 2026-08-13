import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import fixture from './fixtures/knowledge-page-youtube.json' with { type: 'json' };
import { buildKnowledgePageArtifact, type KnowledgePageFixtureInput } from '../src/content/knowledge-page.js';
import { SqlJsContentRepository } from '../src/content/sqljs-repository.js';
import type { StoredContentItem } from '../src/content/repository.js';
import { DurableJobWorker, JobStageError } from '../src/jobs/worker.js';

const ITEM_ID = 'youtube:dQw4w9WgXcQ';

async function setup() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fieldtheory-worker-'));
  const repo = await SqlJsContentRepository.open(path.join(dir, 'content.sqlite'));
  const artifact = buildKnowledgePageArtifact(structuredClone(fixture) as KnowledgePageFixtureInput);
  const item: StoredContentItem = { ...artifact.item, createdAt: '2026-08-12T20:00:00.000Z', updatedAt: '2026-08-12T20:00:00.000Z' };
  await repo.upsertItem(item);
  return repo;
}

test('worker completes a leased stage and blocks stages with no handler', async () => {
  const repo = await setup();
  await repo.enqueueJob(ITEM_ID, 'metadata', 'one', 1, '2026-08-12T20:00:00.000Z');
  const worker = new DurableJobWorker({ repository: repo, workerId: 'worker', handlers: { metadata: async () => {} }, now: () => new Date('2026-08-12T20:00:01.000Z') });
  assert.equal(await worker.runOnce(), true);
  assert.equal((await repo.listJobs())[0].state, 'succeeded');

  await repo.enqueueJob(ITEM_ID, 'summary', 'two', 1, '2026-08-12T20:00:02.000Z');
  assert.equal(await worker.runOnce(), true);
  assert.equal((await repo.listJobs()).find((job) => job.stage === 'summary')?.lastErrorCode, 'handler_missing');
  await repo.close();
});

test('worker distinguishes retryable, blocked, and terminal stage failures', async () => {
  const cases = [
    { stage: 'metadata' as const, disposition: 'retry' as const, expected: 'retry_wait' },
    { stage: 'transcript' as const, disposition: 'blocked' as const, expected: 'blocked' },
    { stage: 'summary' as const, disposition: 'failed' as const, expected: 'failed' },
  ];
  for (const [index, value] of cases.entries()) {
    const repo = await setup();
    await repo.enqueueJob(ITEM_ID, value.stage, `input-${index}`, 1, '2026-08-12T20:00:00.000Z');
    const worker = new DurableJobWorker({
      repository: repo, workerId: 'worker', random: () => 0, now: () => new Date('2026-08-12T20:00:01.000Z'),
      handlers: { [value.stage]: async () => { throw new JobStageError('fixture_error', 'Fixture failed.', value.disposition); } },
    });
    await worker.runOnce();
    assert.equal((await repo.listJobs())[0].state, value.expected);
    await repo.close();
  }
});

test('shutdown requeues interrupted work while user cancellation remains resumable', async () => {
  for (const kind of ['shutdown', 'cancel'] as const) {
    const repo = await setup();
    await repo.enqueueJob(ITEM_ID, 'transcript', kind, 1, '2026-08-12T20:00:00.000Z');
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => { started = resolve; });
    const worker = new DurableJobWorker({
      repository: repo, workerId: 'worker', now: () => new Date('2026-08-12T20:00:01.000Z'),
      handlers: { transcript: async (_job, signal) => new Promise<void>((_resolve, reject) => {
        started();
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }) },
    });
    const running = worker.runOnce();
    await didStart;
    if (kind === 'shutdown') worker.stop(); else worker.cancelCurrent();
    await running;
    assert.equal((await repo.listJobs())[0].state, kind === 'shutdown' ? 'queued' : 'cancelled');
    await repo.close();
  }
});

test('worker stops retrying after the configured attempt ceiling', async () => {
  const repo = await setup();
  const job = await repo.enqueueJob(ITEM_ID, 'metadata', 'ceiling', 1, '2026-08-12T20:00:00.000Z');
  const handler = async () => { throw new JobStageError('network', 'Still offline.', 'retry'); };
  const times = ['2026-08-12T20:00:01.000Z', '2026-08-12T20:00:03.000Z'];
  let timeIndex = 0;
  const worker = new DurableJobWorker({ repository: repo, workerId: 'worker', handlers: { metadata: handler }, maxAttempts: 2, random: () => 0, now: () => new Date(times[Math.min(timeIndex++, times.length - 1)]) });
  await worker.runOnce();
  await repo.retryJob(job.id, '2026-08-12T20:00:03.000Z');
  await worker.runOnce();
  assert.equal((await repo.listJobs())[0].state, 'failed');
  await repo.close();
});
