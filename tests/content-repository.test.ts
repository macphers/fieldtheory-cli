import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import fixture from './fixtures/knowledge-page-youtube.json' with { type: 'json' };
import { buildKnowledgePageArtifact, normalizeTranscript, type KnowledgePageFixtureInput } from '../src/content/knowledge-page.js';
import { SqlJsContentRepository } from '../src/content/sqljs-repository.js';
import type { StoredContentItem } from '../src/content/repository.js';
import { jobInputFingerprint } from '../src/jobs/state-machine.js';
import { openDb, saveDb } from '../src/db.js';

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
  const transcriptHit = (await repo.searchContent('practical mechanism'))[0];
  assert.equal(transcriptHit.matchType, 'transcript');
  assert.equal(transcriptHit.item.canonicalId, item.canonicalId);
  assert.equal(transcriptHit.startMs, 60000);
  const metadataHit = (await repo.searchContent(item.title))[0];
  assert.equal(metadataHit.matchType, 'metadata');
  assert.equal(metadataHit.item.title, item.title);
  await repo.close();

  const reopened = await SqlJsContentRepository.open(dbPath);
  assert.equal((await reopened.getTranscript(item.canonicalId))?.transcript.contentHash, transcript.contentHash);
  assert.equal((await reopened.listItems())[0].canonicalId, item.canonicalId);
  await reopened.close();
});

test('schema v3 preserves YouTube rows and accepts articles and podcasts without video IDs', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fieldtheory-content-migration-'));
  const dbPath = path.join(dir, 'content.sqlite');
  const legacy = await openDb(dbPath);
  legacy.run('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  legacy.run(`CREATE TABLE content_items (
    id TEXT PRIMARY KEY, type TEXT NOT NULL CHECK(type = 'youtube'), video_id TEXT NOT NULL UNIQUE,
    canonical_url TEXT NOT NULL, title TEXT NOT NULL, creator TEXT NOT NULL, duration_ms INTEGER NOT NULL,
    thumbnail_url TEXT, language TEXT, source_chapters_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`);
  legacy.run(`CREATE TABLE source_refs (
    item_id TEXT NOT NULL REFERENCES content_items(id) ON DELETE CASCADE, bookmark_id TEXT NOT NULL,
    bookmark_url TEXT NOT NULL, source_url TEXT NOT NULL, discovered_at TEXT NOT NULL,
    PRIMARY KEY(item_id, bookmark_id, source_url)
  )`);
  legacy.run('INSERT INTO content_items VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', ['youtube:legacyVideo', 'youtube', 'legacyVideo', 'https://www.youtube.com/watch?v=legacyVideo', 'Legacy video', 'Creator', 60_000, null, 'en', null, NOW, NOW]);
  legacy.run('INSERT INTO source_refs VALUES (?,?,?,?,?)', ['youtube:legacyVideo', 'bookmark-legacy', 'https://x.com/example/status/legacy', 'https://www.youtube.com/watch?v=legacyVideo', NOW]);
  saveDb(legacy, dbPath); legacy.close();

  const repo = await SqlJsContentRepository.open(dbPath);
  assert.equal((await repo.getItem('youtube:legacyVideo'))?.videoId, 'legacyVideo');
  assert.equal((await repo.getItem('youtube:legacyVideo'))?.sourceRefs[0].bookmarkId, 'bookmark-legacy');
  await repo.upsertItem({ canonicalId: 'article:x:one', canonicalUrl: 'https://x.com/example/article/one', type: 'article', sourceRefs: [], title: 'Article', creator: 'Author', durationMs: 30_000, createdAt: NOW, updatedAt: NOW });
  assert.equal((await repo.getItem('article:x:one'))?.type, 'article');
  assert.equal((await repo.getItem('article:x:one'))?.videoId, undefined);
  await repo.upsertItem({ canonicalId: 'podcast:one', canonicalUrl: 'https://podcast.example/episode/one', type: 'podcast', mediaUrl: 'https://cdn.example/one.mp3', sourceRefs: [], title: 'Podcast', creator: 'Host', durationMs: 180_000, createdAt: NOW, updatedAt: NOW });
  assert.equal((await repo.getItem('podcast:one'))?.mediaUrl, 'https://cdn.example/one.mp3');
  await repo.close();
});

test('schema v4 migrates queued jobs with safe scheduling and fencing defaults', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fieldtheory-job-migration-'));
  const dbPath = path.join(dir, 'content.sqlite');
  const legacy = await openDb(dbPath);
  legacy.run('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  legacy.run(`CREATE TABLE content_items (
    id TEXT PRIMARY KEY, type TEXT NOT NULL CHECK(type IN ('youtube','article','podcast')), video_id TEXT UNIQUE,
    canonical_url TEXT NOT NULL, title TEXT NOT NULL, creator TEXT NOT NULL, duration_ms INTEGER NOT NULL,
    thumbnail_url TEXT, media_url TEXT, language TEXT, source_chapters_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`);
  legacy.run(`CREATE TABLE processing_jobs (
    id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES content_items(id) ON DELETE CASCADE,
    stage TEXT NOT NULL, input_fingerprint TEXT NOT NULL, implementation_version INTEGER NOT NULL,
    state TEXT NOT NULL, attempt_count INTEGER NOT NULL DEFAULT 0, next_retry_at TEXT,
    lease_owner TEXT, lease_expires_at TEXT, started_at TEXT, last_error_code TEXT, last_error_detail TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(item_id, stage, input_fingerprint, implementation_version)
  )`);
  legacy.run('INSERT INTO content_items VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', ['youtube:legacy-job', 'youtube', 'legacy-job', 'https://www.youtube.com/watch?v=legacy-job', 'Legacy job', 'Creator', 60_000, null, null, 'en', null, NOW, NOW]);
  legacy.run('INSERT INTO processing_jobs VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', ['legacy-job-id', 'youtube:legacy-job', 'metadata', 'legacy-input', 1, 'queued', 0, null, null, null, null, null, null, NOW, NOW]);
  saveDb(legacy, dbPath);
  legacy.close();

  const repo = await SqlJsContentRepository.open(dbPath);
  const [job] = await repo.listJobs('youtube:legacy-job');
  assert.deepEqual({ priority: job.priority, resourceClass: job.resourceClass, leaseToken: job.leaseToken, state: job.state }, { priority: 0, resourceClass: 'network', leaseToken: 0, state: 'queued' });
  const leased = await repo.leaseNextJob('migration-worker', NOW);
  assert.equal(leased?.leaseToken, 1);
  await repo.close();
});

test('library search uses whole tokens, requires every query term, and preserves true transcript hits at the limit', async () => {
  const { item, transcript } = domainFixture();
  const { repo } = await repository();
  await repo.upsertItem(item);
  const searchableTranscript = normalizeTranscript(transcript.language, transcript.provenance, transcript.segments.map((segment, index) => ({
    startMs: segment.startMs,
    endMs: segment.endMs,
    text: index === 0 ? `AI breakthrough. ${segment.text}` : segment.text,
  })));
  await repo.saveTranscript({ itemId: item.canonicalId, artifactHash: searchableTranscript.contentHash, artifactPath: '/fixture.json', transcript: searchableTranscript, acquiredAt: NOW });
  for (let index = 0; index < 20; index += 1) {
    await repo.upsertItem({
      ...item,
      canonicalId: `youtube:chair-${index}`,
      videoId: `chair-${index}`,
      canonicalUrl: `https://www.youtube.com/watch?v=chair-${index}`,
      title: `Chair design ${index}`,
      sourceRefs: [],
    });
  }

  const aiHits = await repo.searchContent('AI', 20);
  assert.ok(aiHits.some((hit) => hit.item.canonicalId === item.canonicalId && hit.matchType === 'transcript'));
  assert.ok(aiHits.every((hit) => !hit.item.title.startsWith('Chair')));
  assert.deepEqual(await repo.searchContent('practical zebra'), []);
  await repo.close();
});

test('related content ranks locally embedded transcript topics and excludes the current item', async () => {
  const { item, transcript } = domainFixture();
  const { repo } = await repository();
  await repo.upsertItem(item);
  await repo.saveTranscript({ itemId: item.canonicalId, artifactHash: transcript.contentHash, artifactPath: '/fixture.json', transcript, acquiredAt: NOW });
  const relatedItem = { ...item, canonicalId: 'youtube:related-topic' as const, videoId: 'relatedTopic', canonicalUrl: 'https://www.youtube.com/watch?v=relatedTopic', title: 'How Practical Systems Work', sourceRefs: [] };
  const unrelatedItem = { ...item, canonicalId: 'youtube:unrelated-topic' as const, videoId: 'unrelatedTopic', canonicalUrl: 'https://www.youtube.com/watch?v=unrelatedTopic', title: 'Sourdough at Home', creator: 'Bread Channel', sourceRefs: [] };
  const relatedTranscript = normalizeTranscript('en', transcript.provenance, [{ startMs: 0, endMs: 60_000, text: 'A practical mechanism uses a concrete example to explain the central question.' }]);
  const unrelatedTranscript = normalizeTranscript('en', transcript.provenance, [{ startMs: 0, endMs: 60_000, text: 'Mix flour water starter and salt before baking the loaf.' }]);
  await repo.upsertItem(relatedItem); await repo.upsertItem(unrelatedItem);
  await repo.saveTranscript({ itemId: relatedItem.canonicalId, artifactHash: relatedTranscript.contentHash, artifactPath: '/related.json', transcript: relatedTranscript, acquiredAt: NOW });
  await repo.saveTranscript({ itemId: unrelatedItem.canonicalId, artifactHash: unrelatedTranscript.contentHash, artifactPath: '/unrelated.json', transcript: unrelatedTranscript, acquiredAt: NOW });

  const hits = await repo.relatedContent(item.canonicalId);
  assert.equal(hits[0].item.canonicalId, relatedItem.canonicalId);
  assert.ok(hits[0].score > 0.04);
  assert.ok(hits.every((hit) => hit.item.canonicalId !== item.canonicalId));
  assert.ok(!hits.some((hit) => hit.item.canonicalId === unrelatedItem.canonicalId));
  await repo.close();
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
  assert.ok((await repo.searchContent(page.overview[0].text)).some((hit) => hit.matchType === 'summary' && hit.item.canonicalId === item.canonicalId));
  await assert.rejects(repo.saveSummary({ itemId: item.canonicalId, transcriptContentHash: 'stale', overview: page.overview, details: page.details, provider: 'fixture', promptVersion: 1, artifactHash: 'stale-summary', validationState: 'supported', createdAt: NOW, promotedAt: NOW }), /current transcript/);
  const replacement = normalizeTranscript(transcript.language, transcript.provenance, transcript.segments.map((segment, index) => ({
    startMs: segment.startMs,
    endMs: segment.endMs,
    text: index === 0 ? 'Replacement transcript with no prior summary language.' : segment.text,
  })));
  await repo.saveTranscript({ itemId: item.canonicalId, artifactHash: replacement.contentHash, artifactPath: '/replacement.json', transcript: replacement, acquiredAt: NOW });
  assert.ok(!(await repo.searchContent(page.overview[0].text)).some((hit) => hit.matchType === 'summary'));
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
  await repo.transitionJob(running!.id, { state: 'retry_wait', now: '2026-08-12T20:00:00.500Z', nextRetryAt: '2026-08-12T20:00:02.000Z', errorCode: 'network', lease: { workerId: 'worker-one', token: running!.leaseToken } });
  assert.equal(await repo.leaseNextJob('worker-two', '2026-08-12T20:00:01.000Z'), null);
  const secondRun = await repo.leaseNextJob('worker-two', '2026-08-12T20:00:02.000Z', 1000);
  assert.equal(secondRun?.attemptCount, 2);
  assert.equal(await repo.recoverExpiredLeases('2026-08-12T20:00:04.000Z'), 1);
  assert.equal((await repo.listJobs(item.canonicalId))[0].state, 'queued');
  await repo.close();
});

test('leases by resource class and priority, blocks dependencies, and atomically fans out children', async () => {
  const { item } = domainFixture();
  const { repo } = await repository();
  await repo.upsertItem(item);
  const parent = await repo.enqueueJob(item.canonicalId, 'metadata', 'parent', 1, NOW, { priority: 50, resourceClass: 'network' });
  const dependent = await repo.enqueueJob(item.canonicalId, 'summary', 'dependent', 1, NOW, { priority: 100, resourceClass: 'model', dependsOnJobId: parent.id });
  await repo.enqueueJob(item.canonicalId, 'metadata', 'low-priority', 1, NOW, { priority: 1, resourceClass: 'network' });

  assert.equal(await repo.leaseNextJob('model-worker', NOW, 60_000, 'model'), null);
  const leasedParent = await repo.leaseNextJob('network-worker', NOW, 60_000, 'network');
  assert.equal(leasedParent?.id, parent.id);
  assert.equal(leasedParent?.priority, 50);
  await repo.completeJob(parent.id, {
    state: 'succeeded', now: '2026-08-12T20:00:01.000Z',
    lease: { workerId: 'network-worker', token: leasedParent!.leaseToken },
  }, [{ stage: 'transcript', inputFingerprint: 'fanout', implementationVersion: 1, options: { priority: 75, resourceClass: 'network', dependsOnJobId: parent.id } }]);

  const modelJob = await repo.leaseNextJob('model-worker', '2026-08-12T20:00:01.000Z', 60_000, 'model');
  assert.equal(modelJob?.id, dependent.id);
  const networkJob = await repo.leaseNextJob('network-worker', '2026-08-12T20:00:01.000Z', 60_000, 'network');
  assert.equal(networkJob?.stage, 'transcript');
  assert.equal(networkJob?.priority, 75);
  await repo.close();
});

test('lease fencing rejects stale completion and stale artifact promotion after recovery', async () => {
  const { item, transcript } = domainFixture();
  const { repo } = await repository();
  await repo.upsertItem(item);
  const job = await repo.enqueueJob(item.canonicalId, 'transcript', 'fenced', 1, NOW);
  const firstLease = await repo.leaseNextJob('worker-one', NOW, 1_000);
  await repo.recoverExpiredLeases('2026-08-12T20:00:02.000Z');
  const secondLease = await repo.leaseNextJob('worker-two', '2026-08-12T20:00:02.000Z', 60_000);
  assert.equal(firstLease?.leaseToken, 1);
  assert.equal(secondLease?.leaseToken, 2);

  await assert.rejects(repo.transitionJob(job.id, {
    state: 'succeeded', now: '2026-08-12T20:00:03.000Z',
    lease: { workerId: 'worker-one', token: firstLease!.leaseToken },
  }), /lease fence/);
  await assert.rejects(repo.saveTranscript({
    itemId: item.canonicalId, artifactHash: transcript.contentHash, artifactPath: '/stale.json', transcript, acquiredAt: NOW,
  }, { jobId: job.id, workerId: 'worker-one', token: firstLease!.leaseToken }), /stale artifact write/);

  await repo.saveTranscript({ itemId: item.canonicalId, artifactHash: transcript.contentHash, artifactPath: '/current.json', transcript, acquiredAt: NOW }, {
    jobId: job.id, workerId: 'worker-two', token: secondLease!.leaseToken,
  });
  await repo.completeJob(job.id, { state: 'succeeded', now: '2026-08-12T20:00:03.000Z', lease: { workerId: 'worker-two', token: secondLease!.leaseToken } });
  assert.equal((await repo.getTranscript(item.canonicalId))?.artifactPath, '/current.json');
  await repo.close();
});

test('atomic job completion rolls back artifact promotion when child fan-out fails', async () => {
  const { item, transcript } = domainFixture();
  const { repo } = await repository();
  await repo.upsertItem(item);
  const job = await repo.enqueueJob(item.canonicalId, 'transcript', 'atomic', 1, NOW);
  const lease = await repo.leaseNextJob('worker', NOW);
  await assert.rejects(repo.completeJob(job.id, {
    state: 'succeeded', now: '2026-08-12T20:00:01.000Z', lease: { workerId: 'worker', token: lease!.leaseToken },
  }, [{ stage: 'chapters', inputFingerprint: 'invalid-child', implementationVersion: 1, options: { dependsOnJobId: 'missing-parent' } }], {
    kind: 'transcript', item, transcript: { itemId: item.canonicalId, artifactHash: transcript.contentHash, artifactPath: '/atomic.json', transcript, acquiredAt: NOW },
  }), /dependency must exist/);
  assert.equal(await repo.getTranscript(item.canonicalId), null);
  assert.equal((await repo.listJobs(item.canonicalId))[0].state, 'running');
  await repo.close();
});

test('projects capabilities from current promoted artifacts instead of optional job states', async () => {
  const { item, transcript } = domainFixture();
  const { repo } = await repository();
  await repo.upsertItem(item);
  assert.deepEqual(await repo.itemCapabilities(item.canonicalId), {
    metadata: true, text: false, exactSearch: false, chapters: false, summary: false, chat: false, semantic: false, clustered: false,
  });
  await repo.saveTranscript({ itemId: item.canonicalId, artifactHash: transcript.contentHash, artifactPath: '/fixture.json', transcript, acquiredAt: NOW });
  assert.deepEqual(await repo.itemCapabilities(item.canonicalId), {
    metadata: true, text: true, exactSearch: true, chapters: false, summary: false, chat: true, semantic: false, clustered: false,
  });
  const page = buildKnowledgePageArtifact(structuredClone(fixture) as KnowledgePageFixtureInput);
  await repo.replaceChapters({ itemId: item.canonicalId, transcriptContentHash: transcript.contentHash, artifactHash: 'capability-chapters', chapters: page.chapters });
  await repo.saveSummary({ itemId: item.canonicalId, transcriptContentHash: transcript.contentHash, chaptersArtifactHash: 'capability-chapters', overview: page.overview, details: page.details, provider: 'fixture', promptVersion: 1, artifactHash: 'capability-summary', validationState: 'supported', createdAt: NOW, promotedAt: NOW });
  assert.deepEqual(await repo.itemCapabilities(item.canonicalId), {
    metadata: true, text: true, exactSearch: true, chapters: true, summary: true, chat: true, semantic: false, clustered: false,
  });

  const replacement = normalizeTranscript('en', transcript.provenance, [{ startMs: 0, endMs: 1_000, text: 'A replacement invalidates derived artifacts.' }]);
  await repo.saveTranscript({ itemId: item.canonicalId, artifactHash: replacement.contentHash, artifactPath: '/replacement.json', transcript: replacement, acquiredAt: NOW });
  const capabilities = await repo.itemCapabilities(item.canonicalId);
  assert.equal(capabilities.text, true);
  assert.equal(capabilities.summary, false);
  assert.equal(capabilities.chapters, false);
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
    await repo.transitionJob(job.id, { state: 'succeeded', now: `2026-08-12T20:00:0${stage === 'metadata' ? 1 : 2}.000Z`, lease: { workerId: 'worker', token: running!.leaseToken } });
  }
  assert.equal(await repo.itemStatus(item.canonicalId, ['metadata', 'transcript']), 'ready');
  const summary = await repo.enqueueJob(item.canonicalId, 'summary', 'summary-input', 1, '2026-08-12T20:00:03.000Z');
  assert.equal(await repo.itemStatus(item.canonicalId, ['metadata', 'transcript', 'summary']), 'processing');
  const running = await repo.leaseNextJob('worker', '2026-08-12T20:00:03.000Z');
  await repo.transitionJob(running!.id, { state: 'blocked', now: '2026-08-12T20:00:04.000Z', errorCode: 'provider_missing', lease: { workerId: 'worker', token: running!.leaseToken } });
  assert.equal(summary.id, running!.id);
  assert.equal(await repo.itemStatus(item.canonicalId, ['metadata', 'transcript', 'summary']), 'blocked');
  await repo.close();
});

test('persists per-item long transcription consent and supports queued cancellation', async () => {
  const { item } = domainFixture();
  const { repo } = await repository();
  await repo.upsertItem(item);
  assert.equal(await repo.hasLongTranscriptionOverride(item.canonicalId), false);
  await repo.setLongTranscriptionOverride(item.canonicalId, true);
  assert.equal(await repo.hasLongTranscriptionOverride(item.canonicalId), true);
  const job = await repo.enqueueJob(item.canonicalId, 'transcript', 'cancel-input', 1, NOW);
  assert.equal((await repo.cancelJob(job.id, NOW)).state, 'cancelled');
  assert.equal((await repo.retryJob(job.id, NOW)).state, 'queued');
  await repo.close();
});

test('activity recording can be disabled and cleared independently', async () => {
  const { item } = domainFixture();
  const { repo } = await repository();
  await repo.upsertItem(item);
  assert.equal(await repo.recordActivity({ id: 'event-one', itemId: item.canonicalId, type: 'item_opened', createdAt: NOW }), true);
  assert.equal(await repo.recordActivity({ id: 'event-citation', itemId: item.canonicalId, type: 'citation_clicked', createdAt: NOW }), true);
  const report = await repo.activityReport();
  assert.equal(report.totalEvents, 2);
  assert.deepEqual({ opens: report.items[0].opens, citations: report.items[0].citationClicks }, { opens: 1, citations: 1 });
  assert.deepEqual({ span: report.habitTrial.spanDays, active: report.habitTrial.activeDays, revisited: report.habitTrial.revisitedPages, met: report.habitTrial.met }, { span: 1, active: 1, revisited: 0, met: false });
  await repo.setActivityEnabled(false);
  assert.equal(await repo.recordActivity({ id: 'event-two', itemId: item.canonicalId, type: 'note_saved', createdAt: NOW }), false);
  assert.equal(await repo.clearActivity(), 2);
  assert.equal(await repo.clearActivity(), 0);
  await repo.close();
});

test('activity report marks the seven-day three-page habit gate explicitly', async () => {
  const { item } = domainFixture();
  const { repo } = await repository();
  for (let index = 0; index < 3; index += 1) {
    const videoId = `trial-video-${index}`;
    const trialItem = {
      ...item,
      canonicalId: `youtube:${videoId}` as const,
      videoId,
      canonicalUrl: `https://www.youtube.com/watch?v=${videoId}`,
      title: `Trial item ${index + 1}`,
      sourceRefs: item.sourceRefs.map((source) => ({ ...source, bookmarkId: `trial-bookmark-${index}` })),
    };
    await repo.upsertItem(trialItem);
    await repo.recordActivity({ id: `open-${index}-first`, itemId: trialItem.canonicalId, type: 'item_opened', createdAt: '2026-08-01T12:00:00.000Z' });
    await repo.recordActivity({ id: `open-${index}-return`, itemId: trialItem.canonicalId, type: 'item_opened', createdAt: '2026-08-07T12:00:00.000Z' });
  }
  const report = await repo.activityReport();
  assert.deepEqual(report.habitTrial, {
    firstActivityAt: '2026-08-01T12:00:00.000Z',
    lastActivityAt: '2026-08-07T12:00:00.000Z',
    spanDays: 7,
    activeDays: 2,
    revisitedPages: 3,
    requiredSpanDays: 7,
    requiredRevisitedPages: 3,
    met: true,
  });
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
