import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import fixture from './fixtures/knowledge-page-youtube.json' with { type: 'json' };
import { buildKnowledgePageArtifact, type KnowledgePageFixtureInput } from '../src/content/knowledge-page.js';
import { SqlJsContentRepository } from '../src/content/sqljs-repository.js';
import type { StoredContentItem } from '../src/content/repository.js';
import { startContentServer } from '../src/server/http.js';

async function setup(chat?: Parameters<typeof startContentServer>[0]['chat']) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fieldtheory-server-'));
  const repository = await SqlJsContentRepository.open(path.join(dir, 'content.sqlite'));
  const artifact = buildKnowledgePageArtifact(structuredClone(fixture) as KnowledgePageFixtureInput);
  const item: StoredContentItem = { ...artifact.item, language: artifact.transcript.language, createdAt: '2026-08-12T20:00:00.000Z', updatedAt: '2026-08-12T20:00:00.000Z' };
  await repository.upsertItem(item);
  await repository.saveTranscript({ itemId: item.canonicalId, artifactHash: artifact.transcript.contentHash, artifactPath: '/artifact.json', transcript: artifact.transcript, acquiredAt: '2026-08-12T20:00:00.000Z' });
  const job = await repository.enqueueJob(item.canonicalId, 'summary', 'summary-input', 1, '2026-08-12T20:00:00.000Z');
  const leased = await repository.leaseNextJob('worker', '2026-08-12T20:00:00.000Z');
  await repository.transitionJob(job.id, { state: 'failed', now: '2026-08-12T20:00:01.000Z', errorCode: 'provider_unavailable', lease: { workerId: 'worker', token: leased!.leaseToken } });
  const server = await startContentServer({ repository, chat, now: () => Date.parse('2026-08-12T20:00:02.000Z') });
  return { repository, server, item, job };
}

async function authenticate(server: Awaited<ReturnType<typeof startContentServer>>) {
  const bootstrap = await fetch(server.bootstrapUrl, { redirect: 'manual' });
  const setCookie = bootstrap.headers.get('set-cookie')!;
  const cookie = setCookie.split(';')[0];
  const session = await fetch(`${server.origin}/api/v1/session`, { headers: { cookie } });
  const { csrf } = await session.json() as { csrf: string };
  return { bootstrap, cookie, csrf };
}

test('bootstrap removes the launch token, sets a strict HttpOnly cookie, and cannot be replayed', async () => {
  const { repository, server } = await setup();
  try {
    const { bootstrap } = await authenticate(server);
    assert.equal(bootstrap.status, 303);
    assert.equal(bootstrap.headers.get('location'), '/');
    assert.match(bootstrap.headers.get('set-cookie')!, /HttpOnly; SameSite=Strict/);
    assert.equal(bootstrap.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
    const replay = await fetch(server.bootstrapUrl, { redirect: 'manual' });
    assert.equal(replay.status, 401);
    assert.equal((await replay.json() as { code: string }).code, 'invalid_bootstrap_token');
  } finally { await server.close(); await repository.close(); }
});

test('authenticated session outlives the short bootstrap capability', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fieldtheory-session-ttl-'));
  const repository = await SqlJsContentRepository.open(path.join(dir, 'content.sqlite'));
  let clock = 1_000;
  const server = await startContentServer({ repository, now: () => clock, bootstrapTtlMs: 100, sessionTtlMs: 1_000 });
  try {
    const { bootstrap, cookie } = await authenticate(server);
    assert.match(bootstrap.headers.get('set-cookie')!, /Max-Age=1(?:;|$)/);
    clock = 1_101;
    assert.equal((await fetch(`${server.origin}/api/v1/items`, { headers: { cookie } })).status, 200);
    clock = 2_001;
    assert.equal((await fetch(`${server.origin}/api/v1/items`, { headers: { cookie } })).status, 401);
  } finally { await server.close(); await repository.close(); }
});

test('API rejects unauthenticated, forwarded, wrong-origin, and missing-CSRF requests', async () => {
  const { repository, server, item } = await setup();
  try {
    assert.equal((await fetch(`${server.origin}/api/v1/items`)).status, 401);
    const { cookie, csrf } = await authenticate(server);
    assert.equal((await fetch(`${server.origin}/api/v1/items`, { headers: { cookie, 'x-forwarded-for': '203.0.113.5' } })).status, 400);
    assert.equal((await fetch(`${server.origin}/api/v1/items/${encodeURIComponent(item.canonicalId)}/note`, { method: 'PUT', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ markdown: 'note', expectedVersion: 0 }) })).status, 403);
    assert.equal((await fetch(`${server.origin}/api/v1/items/${encodeURIComponent(item.canonicalId)}/note`, { method: 'PUT', headers: { cookie, origin: 'https://evil.example', 'x-fieldtheory-csrf': csrf, 'content-type': 'application/json' }, body: JSON.stringify({ markdown: 'note', expectedVersion: 0 }) })).status, 403);
  } finally { await server.close(); await repository.close(); }
});

test('serves items, paginated transcripts, optimistic notes, jobs, and retry through the versioned API', async () => {
  const { repository, server, item, job } = await setup();
  try {
    const { cookie, csrf } = await authenticate(server);
    const headers = { cookie };
    const list = await fetch(`${server.origin}/api/v1/items`, { headers });
    assert.equal(list.status, 200);
    const listBody = await list.json() as { data: Array<{ canonicalId: string; status: string }> };
    assert.equal(listBody.data[0].canonicalId, item.canonicalId);
    assert.equal(list.headers.get('access-control-allow-origin'), null);
    assert.match(list.headers.get('content-security-policy')!, /frame-src https:\/\/www\.youtube\.com/);

    const transcript = await fetch(`${server.origin}/api/v1/items/${encodeURIComponent(item.canonicalId)}/transcript?limit=1`, { headers });
    const transcriptBody = await transcript.json() as { data: unknown[]; nextCursor: number };
    assert.equal(transcriptBody.data.length, 1);
    assert.equal(transcriptBody.nextCursor, 1);
    assert.equal((await fetch(`${server.origin}/api/v1/items?limit=not-a-number`, { headers })).status, 400);
    const search = await fetch(`${server.origin}/api/v1/search?q=practical%20mechanism`, { headers });
    assert.equal(search.status, 200);
    const searchBody = await search.json() as { data: Array<{ item: { canonicalId: string }; matchType: string; startMs?: number }> };
    assert.equal(searchBody.data[0].item.canonicalId, item.canonicalId);
    assert.equal(searchBody.data[0].matchType, 'transcript');
    assert.equal(searchBody.data[0].startMs, 60000);
    assert.equal((await fetch(`${server.origin}/api/v1/search?q=`, { headers })).status, 400);
    const related = await fetch(`${server.origin}/api/v1/items/${encodeURIComponent(item.canonicalId)}/related`, { headers });
    assert.equal(related.status, 200);
    assert.deepEqual((await related.json() as { data: unknown[]; method: string }), { data: [], method: 'local-tfidf-v1' });
    assert.equal((await fetch(`${server.origin}/api/v1/items/${encodeURIComponent(item.canonicalId)}/related?limit=invalid`, { headers })).status, 400);
    assert.equal((await fetch(`${server.origin}/api/v1/items/${encodeURIComponent(item.canonicalId)}/transcript?cursor=-1`, { headers })).status, 400);

    const mutationHeaders = { cookie, origin: server.origin, 'x-fieldtheory-csrf': csrf, 'content-type': 'application/json' };
    const note = await fetch(`${server.origin}/api/v1/items/${encodeURIComponent(item.canonicalId)}/note`, { method: 'PUT', headers: mutationHeaders, body: JSON.stringify({ markdown: 'Remember this.', expectedVersion: 0 }) });
    assert.equal(note.status, 200);
    assert.equal((await note.json() as { version: number }).version, 1);
    const conflict = await fetch(`${server.origin}/api/v1/items/${encodeURIComponent(item.canonicalId)}/note`, { method: 'PUT', headers: mutationHeaders, body: JSON.stringify({ markdown: 'Stale.', expectedVersion: 0 }) });
    assert.equal(conflict.status, 409);

    const jobs = await fetch(`${server.origin}/api/v1/jobs?itemId=${encodeURIComponent(item.canonicalId)}`, { headers });
    assert.equal((await jobs.json() as { data: unknown[] }).data.length, 1);
    const retry = await fetch(`${server.origin}/api/v1/items/${encodeURIComponent(item.canonicalId)}/retry`, { method: 'POST', headers: mutationHeaders, body: JSON.stringify({ jobId: job.id }) });
    assert.equal(retry.status, 200);
    assert.equal((await retry.json() as { state: string }).state, 'queued');
  } finally { await server.close(); await repository.close(); }
});

test('processing controls persist long-transcription consent and cancel queued work', async () => {
  const { repository, server, item } = await setup();
  try {
    const job = await repository.enqueueJob(item.canonicalId, 'transcript', 'transcript-input', 1, '2026-08-12T20:00:02.000Z');
    const leased = await repository.leaseNextJob('worker', '2026-08-12T20:00:02.000Z');
    await repository.transitionJob(job.id, { state: 'blocked', now: '2026-08-12T20:00:02.000Z', errorCode: 'captions_unavailable', lease: { workerId: 'worker', token: leased!.leaseToken } });
    const { cookie, csrf } = await authenticate(server);
    const headers = { cookie, origin: server.origin, 'x-fieldtheory-csrf': csrf, 'content-type': 'application/json' };
    const override = await fetch(`${server.origin}/api/v1/items/${encodeURIComponent(item.canonicalId)}/transcription-override`, { method: 'PUT', headers, body: JSON.stringify({ allowLong: true, retryJobId: job.id }) });
    assert.equal(override.status, 200);
    assert.equal(await repository.hasLongTranscriptionOverride(item.canonicalId), true);
    const cancel = await fetch(`${server.origin}/api/v1/items/${encodeURIComponent(item.canonicalId)}/cancel`, { method: 'POST', headers, body: JSON.stringify({ jobId: job.id }) });
    assert.equal(cancel.status, 200);
    assert.equal((await repository.listJobs(item.canonicalId)).find((candidate) => candidate.id === job.id)?.state, 'cancelled');
  } finally { await server.close(); await repository.close(); }
});

test('long-transcription consent cannot retry another item or a non-transcript stage', async () => {
  const { repository, server, item, job } = await setup();
  try {
    const other: StoredContentItem = { ...item, canonicalId: 'youtube:abcdefghijk', videoId: 'abcdefghijk', canonicalUrl: 'https://www.youtube.com/watch?v=abcdefghijk', sourceRefs: [] };
    await repository.upsertItem(other);
    const otherJob = await repository.enqueueJob(other.canonicalId, 'transcript', 'other-transcript', 1, '2026-08-12T20:00:02.000Z');
    const { cookie, csrf } = await authenticate(server);
    const headers = { cookie, origin: server.origin, 'x-fieldtheory-csrf': csrf, 'content-type': 'application/json' };

    const crossItem = await fetch(`${server.origin}/api/v1/items/${encodeURIComponent(item.canonicalId)}/transcription-override`, { method: 'PUT', headers, body: JSON.stringify({ allowLong: true, retryJobId: otherJob.id }) });
    assert.equal(crossItem.status, 404);
    assert.equal(await repository.hasLongTranscriptionOverride(item.canonicalId), false);

    const wrongStage = await fetch(`${server.origin}/api/v1/items/${encodeURIComponent(item.canonicalId)}/transcription-override`, { method: 'PUT', headers, body: JSON.stringify({ allowLong: true, retryJobId: job.id }) });
    assert.equal(wrongStage.status, 404);
    assert.equal(await repository.hasLongTranscriptionOverride(item.canonicalId), false);
  } finally { await server.close(); await repository.close(); }
});

test('activity controls stop future writes without clearing existing events', async () => {
  const { repository, server, item } = await setup();
  try {
    const { cookie, csrf } = await authenticate(server);
    const headers = { cookie, origin: server.origin, 'x-fieldtheory-csrf': csrf, 'content-type': 'application/json' };
    const event = await fetch(`${server.origin}/api/v1/items/${encodeURIComponent(item.canonicalId)}/activity`, { method: 'POST', headers, body: JSON.stringify({ id: 'event-1', type: 'item_opened' }) });
    assert.equal(event.status, 201);
    const disable = await fetch(`${server.origin}/api/v1/settings/activity`, { method: 'PUT', headers, body: JSON.stringify({ enabled: false }) });
    assert.equal(disable.status, 200);
    const ignored = await fetch(`${server.origin}/api/v1/items/${encodeURIComponent(item.canonicalId)}/activity`, { method: 'POST', headers, body: JSON.stringify({ id: 'event-2', type: 'note_saved' }) });
    assert.deepEqual(await ignored.json(), { recorded: false });
    assert.equal(await repository.clearActivity(), 1);
  } finally { await server.close(); await repository.close(); }
});

test('chat endpoint validates questions and returns cited session-scoped answers', async () => {
  const { repository, server, item } = await setup({ answer: async (_itemId, question) => ({ answer: `Grounded: ${question}`, citations: [{ segmentId: 'segment', startMs: 60000, endMs: 120000 }], refused: false }) });
  try {
    const { cookie, csrf } = await authenticate(server);
    const headers = { cookie, origin: server.origin, 'x-fieldtheory-csrf': csrf, 'content-type': 'application/json' };
    const response = await fetch(`${server.origin}/api/v1/items/${encodeURIComponent(item.canonicalId)}/chat`, { method: 'POST', headers, body: JSON.stringify({ question: 'What is the mechanism?' }) });
    assert.equal(response.status, 200);
    const answer = await response.json() as { answer: string; citations: unknown[] };
    assert.match(answer.answer, /mechanism/);
    assert.equal(answer.citations.length, 1);
    const invalid = await fetch(`${server.origin}/api/v1/items/${encodeURIComponent(item.canonicalId)}/chat`, { method: 'POST', headers, body: JSON.stringify({ question: '' }) });
    assert.equal(invalid.status, 400);
  } finally { await server.close(); await repository.close(); }
});

test('activity and item deletion require a matching second confirmation request', async () => {
  const { repository, server, item } = await setup();
  try {
    const { cookie, csrf } = await authenticate(server);
    const headers = { cookie, origin: server.origin, 'x-fieldtheory-csrf': csrf, 'content-type': 'application/json' };
    await fetch(`${server.origin}/api/v1/items/${encodeURIComponent(item.canonicalId)}/activity`, { method: 'POST', headers, body: JSON.stringify({ id: 'event-delete', type: 'item_opened' }) });

    const activityPreview = await fetch(`${server.origin}/api/v1/activity`, { method: 'DELETE', headers, body: '{}' });
    assert.equal(activityPreview.status, 202);
    const activityChallenge = await activityPreview.json() as { challenge: string; manifest: { activityEvents: number } };
    assert.equal(activityChallenge.manifest.activityEvents, 1);
    const activityDelete = await fetch(`${server.origin}/api/v1/activity`, { method: 'DELETE', headers, body: JSON.stringify({ challenge: activityChallenge.challenge }) });
    assert.deepEqual(await activityDelete.json(), { deleted: 1 });

    const preview = await fetch(`${server.origin}/api/v1/items/${encodeURIComponent(item.canonicalId)}`, { method: 'DELETE', headers, body: '{}' });
    assert.equal(preview.status, 202);
    const challenge = await preview.json() as { challenge: string; manifest: { transcriptSegments: number; jobs: number } };
    assert.equal(challenge.manifest.transcriptSegments, 3);
    assert.equal(challenge.manifest.jobs, 1);
    const deletion = await fetch(`${server.origin}/api/v1/items/${encodeURIComponent(item.canonicalId)}`, { method: 'DELETE', headers, body: JSON.stringify({ challenge: challenge.challenge }) });
    assert.equal(deletion.status, 200);
    assert.equal(await repository.getItem(item.canonicalId), null);
  } finally { await server.close(); await repository.close(); }
});

test('serves authenticated built web assets without weakening the CSP', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fieldtheory-static-'));
  await mkdir(path.join(dir, 'assets'));
  await writeFile(path.join(dir, 'index.html'), '<!doctype html><div id="root"></div><script type="module" src="/assets/app.js"></script>');
  await writeFile(path.join(dir, 'assets', 'app.js'), 'document.body.dataset.ready="true";');
  const setupValue = await setup();
  await setupValue.server.close();
  const server = await startContentServer({ repository: setupValue.repository, staticDir: dir, now: () => Date.parse('2026-08-12T20:00:02.000Z') });
  try {
    const { cookie } = await authenticate(server);
    const index = await fetch(`${server.origin}/`, { headers: { cookie } });
    assert.match(await index.text(), /\/assets\/app\.js/);
    const asset = await fetch(`${server.origin}/assets/app.js`, { headers: { cookie } });
    assert.equal(asset.headers.get('content-type'), 'text/javascript; charset=utf-8');
    assert.match(await asset.text(), /dataset\.ready/);
    assert.match(asset.headers.get('content-security-policy')!, /script-src 'self'/);
  } finally { await server.close(); await setupValue.repository.close(); }
});
