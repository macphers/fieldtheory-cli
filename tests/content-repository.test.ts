import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import fixture from './fixtures/knowledge-page-youtube.json' with { type: 'json' };
import { buildKnowledgePageArtifact, type KnowledgePageFixtureInput } from '../src/content/knowledge-page.js';
import { SqlJsContentRepository } from '../src/content/sqljs-repository.js';
import type { StoredContentItem } from '../src/content/repository.js';
import { jobInputFingerprint } from '../src/jobs/state-machine.js';

const NOW = '2026-08-12T20:00:00.000Z';

function domainFixture(): { item: StoredContentItem; transcript: ReturnType<typeof buildKnowledgePageArtifact>['transcript'] } {
  const artifact = buildKnowledgePageArtifact(structuredClone(fixture) as KnowledgePageFixtureInput);
  return {
    item: { ...artifact.item, language: artifact.transcript.language, createdAt: NOW, updatedAt: NOW },
    transcript: artifact.transcript,
  };
}

async function repository() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fieldtheory-content-repo-'));
  return { dir, dbPath: path.join(dir, 'content.sqlite'), repo: await SqlJsContentRepository.open(path.join(dir, 'content.sqlite')) };
}

test('persists canonical items, source refs, transcripts, and item-scoped FTS across restart', async () => {
  const { item, transcript } = domainFixture();
  const { dbPath, repo } = await repository();
  await repo.upsertItem(item);
  await repo.saveTranscript({ itemId: item.canonicalId, artifactHash: transcript.contentHash, artifactPath: `/artifacts/${transcript.contentHash}.json`, transcript, acquiredAt: NOW });
  assert.equal((await repo.getItem(item.canonicalId))?.sourceRefs.length, 1);
  assert.equal((await repo.searchTranscript(item.canonicalId, 'practical mechanism'))[0].startMs, 60000);
  await repo.close();

  const reopened = await SqlJsContentRepository.open(dbPath);
  assert.equal((await reopened.getTranscript(item.canonicalId))?.transcript.contentHash, transcript.contentHash);
  assert.equal((await reopened.listItems())[0].canonicalId, item.canonicalId);
  await reopened.close();
});

test('upserts source provenance without duplicating canonical content', async () => {
  const { item } = domainFixture();
  const { repo } = await repository();
  await Promise.all([
    repo.upsertItem(item),
    repo.upsertItem({ ...item, sourceRefs: [{ bookmarkId: 'second', bookmarkUrl: 'https://x.com/example/status/2', sourceUrl: item.canonicalUrl, discoveredAt: '2026-08-12T21:00:00.000Z' }], updatedAt: '2026-08-12T21:00:00.000Z' }),
  ]);
  const saved = await repo.getItem(item.canonicalId);
  assert.equal((await repo.listItems()).length, 1);
  assert.deepEqual(saved?.sourceRefs.map((ref) => ref.bookmarkId), ['bookmark-001', 'second']);
  await repo.close();
});

test('notes use optimistic versions and survive unrelated processing updates', async () => {
  const { item } = domainFixture();
  const { repo } = await repository();
  await repo.upsertItem(item);
  const first = await repo.putNote(item.canonicalId, 'First note', 0, NOW);
  assert.equal(first.version, 1);
  await assert.rejects(repo.putNote(item.canonicalId, 'Stale edit', 0, NOW), /version conflict/);
  const second = await repo.putNote(item.canonicalId, 'Updated note', 1, '2026-08-12T20:01:00.000Z');
  assert.equal(second.version, 2);
  assert.equal((await repo.getNote(item.canonicalId))?.markdown, 'Updated note');
  await repo.close();
});

test('promotes only chapters and summaries grounded in the current transcript', async () => {
  const { item, transcript } = domainFixture();
  const { repo } = await repository();
  await repo.upsertItem(item);
  await repo.saveTranscript({ itemId: item.canonicalId, artifactHash: transcript.contentHash, artifactPath: '/fixture.json', transcript, acquiredAt: NOW });
  const page = buildKnowledgePageArtifact(structuredClone(fixture) as KnowledgePageFixtureInput);
  await repo.replaceChapters({ itemId: item.canonicalId, transcriptContentHash: transcript.contentHash, artifactHash: 'chapters-hash', chapters: page.chapters, generation: { provider: 'fixture' } });
  await repo.saveSummary({ itemId: item.canonicalId, transcriptContentHash: transcript.contentHash, chaptersArtifactHash: 'chapters-hash', overview: page.overview, details: page.details, provider: 'fixture', promptVersion: 1, artifactHash: 'summary-hash', validationState: 'supported', createdAt: NOW, promotedAt: NOW });
  assert.equal((await repo.getChapters(item.canonicalId))?.chapters.length, page.chapters.length);
  assert.equal((await repo.getSummary(item.canonicalId))?.overview.length, page.overview.length);
  await assert.rejects(repo.saveSummary({ itemId: item.canonicalId, transcriptContentHash: 'stale', overview: page.overview, details: page.details, provider: 'fixture', promptVersion: 1, artifactHash: 'stale-summary', validationState: 'supported', createdAt: NOW, promotedAt: NOW }), /current transcript/);
  await repo.close();
});

test('checkpoint failures report the I/O error and fail the repository closed', async () => {
  const { item } = domainFixture();
  const { dir, repo } = await repository();
  await repo.upsertItem(item);
  await rename(dir, `${dir}-moved`);
  await writeFile(dir, 'blocks recreation of the database directory');

  await assert.rejects(repo.putNote(item.canonicalId, 'Cannot checkpoint.', 0, NOW), (error: unknown) =>
    error instanceof Error && !error.message.toLowerCase().includes('rollback'));
  await assert.rejects(repo.getItem(item.canonicalId), /unavailable after a persistence failure/);
  await repo.close();
});

test('leases jobs serially, records terminal attempts, retries, and recovers expired work', async () => {
  const { item } = domainFixture();
  const { repo } = await repository();
  await repo.upsertItem(item);
  const fingerprint = jobInputFingerprint(item.canonicalId, 'transcript', ['metadata-hash'], 1);
  const queued = await repo.enqueueJob(item.canonicalId, 'transcript', fingerprint, 1, NOW);
  assert.equal(queued.state, 'queued');
  assert.equal((await repo.enqueueJob(item.canonicalId, 'transcript', fingerprint, 1, NOW)).id, queued.id);

  const running = await repo.leaseNextJob('worker-one', NOW, 1000);
  assert.equal(running?.state, 'running');
  assert.equal((await repo.leaseNextJob('worker-two', NOW)), null);
  await repo.transitionJob(running!.id, { state: 'retry_wait', now: '2026-08-12T20:00:00.500Z', nextRetryAt: '2026-08-12T20:00:02.000Z', errorCode: 'network' });
  assert.equal(await repo.leaseNextJob('worker-two', '2026-08-12T20:00:01.000Z'), null);
  const secondRun = await repo.leaseNextJob('worker-two', '2026-08-12T20:00:02.000Z', 1000);
  assert.equal(secondRun?.attemptCount, 2);
  assert.equal(await repo.recoverExpiredLeases('2026-08-12T20:00:04.000Z'), 1);
  assert.equal((await repo.listJobs(item.canonicalId))[0].state, 'queued');
  await repo.close();
});

test('projects aggregate item status from required current jobs', async () => {
  const { item } = domainFixture();
  const { repo } = await repository();
  await repo.upsertItem(item);
  for (const stage of ['metadata', 'transcript'] as const) {
    const job = await repo.enqueueJob(item.canonicalId, stage, `${stage}-input`, 1, NOW);
    const running = await repo.leaseNextJob('worker', NOW);
    assert.equal(running?.id, job.id);
    await repo.transitionJob(job.id, { state: 'succeeded', now: `2026-08-12T20:00:0${stage === 'metadata' ? 1 : 2}.000Z` });
  }
  assert.equal(await repo.itemStatus(item.canonicalId, ['metadata', 'transcript']), 'ready');
  const summary = await repo.enqueueJob(item.canonicalId, 'summary', 'summary-input', 1, '2026-08-12T20:00:03.000Z');
  assert.equal(await repo.itemStatus(item.canonicalId, ['metadata', 'transcript', 'summary']), 'processing');
  const running = await repo.leaseNextJob('worker', '2026-08-12T20:00:03.000Z');
  await repo.transitionJob(running!.id, { state: 'blocked', now: '2026-08-12T20:00:04.000Z', errorCode: 'provider_missing' });
  assert.equal(summary.id, running!.id);
  assert.equal(await repo.itemStatus(item.canonicalId, ['metadata', 'transcript', 'summary']), 'blocked');
  await repo.close();
});

test('activity recording can be disabled and cleared independently', async () => {
  const { item } = domainFixture();
  const { repo } = await repository();
  await repo.upsertItem(item);
  assert.equal(await repo.recordActivity({ id: 'event-one', itemId: item.canonicalId, type: 'item_opened', createdAt: NOW }), true);
  await repo.setActivityEnabled(false);
  assert.equal(await repo.recordActivity({ id: 'event-two', itemId: item.canonicalId, type: 'note_saved', createdAt: NOW }), false);
  assert.equal(await repo.clearActivity(), 1);
  assert.equal(await repo.clearActivity(), 0);
  await repo.close();
});

test('item deletion manifest accounts for dependent records before cascade deletion', async () => {
  const { item, transcript } = domainFixture();
  const { repo } = await repository();
  await repo.upsertItem(item);
  await repo.saveTranscript({ itemId: item.canonicalId, artifactHash: transcript.contentHash, artifactPath: `/outside-test-root/${transcript.contentHash}.json`, transcript, acquiredAt: NOW });
  await repo.putNote(item.canonicalId, 'Keep until confirmed.', 0, NOW);
  await repo.enqueueJob(item.canonicalId, 'metadata', 'delete-input', 1, NOW);
  await repo.recordActivity({ id: 'delete-event', itemId: item.canonicalId, type: 'item_opened', createdAt: NOW });
  const manifest = await repo.deletionManifest(item.canonicalId);
  assert.deepEqual({ segments: manifest?.transcriptSegments, refs: manifest?.sourceRefs, jobs: manifest?.jobs, events: manifest?.activityEvents, note: manifest?.hasNote }, { segments: 3, refs: 1, jobs: 1, events: 1, note: true });
  await repo.deleteItem(item.canonicalId);
  assert.equal(await repo.getItem(item.canonicalId), null);
  assert.equal((await repo.searchTranscript(item.canonicalId, 'mechanism')).length, 0);
  await repo.close();
});
