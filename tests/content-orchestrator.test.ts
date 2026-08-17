import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import fixture from './fixtures/knowledge-page-youtube.json' with { type: 'json' };
import { buildKnowledgePageArtifact, type KnowledgePageFixtureInput } from '../src/content/knowledge-page.js';
import { ContentOrchestrator } from '../src/content/orchestrator.js';
import { SqlJsContentRepository } from '../src/content/sqljs-repository.js';
import { DurableJobWorker } from '../src/jobs/worker.js';
import type { BookmarkRecord } from '../src/types.js';
import { TranscriptAcquisitionError } from '../src/content/transcripts/yt-dlp.js';

test('bookmark discovery runs the durable metadata-to-summary pipeline once per canonical video', async () => {
  const page = buildKnowledgePageArtifact(structuredClone(fixture) as KnowledgePageFixtureInput);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fieldtheory-orchestrator-'));
  const repository = await SqlJsContentRepository.open(path.join(dir, 'content.sqlite'));
  const secondBookmark: BookmarkRecord = { ...structuredClone(fixture.bookmark), id: 'bookmark-002', tweetId: 'tweet-002', url: 'https://x.com/example/status/2', syncedAt: '2026-08-12T20:01:00.000Z' };
  const synthesis = JSON.stringify({
    overview: page.overview.map((claim) => ({ text: claim.text, citations: claim.citations.map(({ startMs, endMs }) => ({ startMs, endMs })) })),
    details: page.details.map((claim) => ({ text: claim.text, citations: claim.citations.map(({ startMs, endMs }) => ({ startMs, endMs })) })),
  });
  const model = {
    provider: 'fixture',
    generate: async () => synthesis,
    checkSupport: async () => 'supported' as const,
  };
  const orchestrator = new ContentOrchestrator({
    repository,
    metadataProvider: { acquireMetadata: async () => ({ videoId: page.item.videoId, title: page.item.title, creator: page.item.creator, durationMs: page.item.durationMs, language: page.transcript.language, creatorChapters: page.chapters.map((chapter) => ({ ...chapter, source: 'creator' as const })) }) },
    transcriptPipeline: { acquire: async () => ({ media: { videoId: page.item.videoId, title: page.item.title, creator: page.item.creator, durationMs: page.item.durationMs, language: page.transcript.language, creatorChapters: page.chapters.map((chapter) => ({ ...chapter, source: 'creator' as const })) }, transcript: page.transcript, artifactPath: path.join(dir, 'transcript.json'), source: 'creator-captions' as const }) },
    model,
    now: () => new Date('2026-08-12T20:00:00.000Z'),
  });

  try {
    const result = await orchestrator.discover([structuredClone(fixture.bookmark), secondBookmark]);
    assert.deepEqual(result, { discovered: 1, enqueued: 1 });
    const worker = new DurableJobWorker({ repository, workerId: 'fixture-worker', handlers: orchestrator.handlers(), now: () => new Date('2026-08-12T20:00:00.000Z') });
    let completed = 0;
    while (await worker.runOnce()) completed += 1;
    assert.equal(completed, 4);
    assert.equal((await repository.getItem(page.item.canonicalId))?.sourceRefs.length, 2);
    assert.equal(await repository.itemStatus(page.item.canonicalId, ['metadata', 'transcript', 'chapters', 'summary']), 'ready');
    assert.equal((await repository.getSummary(page.item.canonicalId))?.overview.length, page.overview.length);
    assert.ok((await repository.listJobs(page.item.canonicalId)).every((job) => job.state === 'succeeded'));
  } finally { await repository.close(); }
});

test('durably blocks transcript jobs for missing local transcription prerequisites', async () => {
  for (const code of ['whisper_binary_missing', 'whisper_model_missing', 'ffmpeg_missing'] as const) {
    const page = buildKnowledgePageArtifact(structuredClone(fixture) as KnowledgePageFixtureInput);
    const dir = await mkdtemp(path.join(os.tmpdir(), 'fieldtheory-orchestrator-blocked-'));
    const repository = await SqlJsContentRepository.open(path.join(dir, 'content.sqlite'));
    await repository.upsertItem({ ...page.item, createdAt: '2026-08-12T20:00:00.000Z', updatedAt: '2026-08-12T20:00:00.000Z' });
    await repository.enqueueJob(page.item.canonicalId, 'transcript', code, 1, '2026-08-12T20:00:00.000Z');
    const orchestrator = new ContentOrchestrator({
      repository,
      metadataProvider: { acquireMetadata: async () => { throw new Error('unused'); } },
      transcriptPipeline: { acquire: async () => { throw new TranscriptAcquisitionError(code, 'Missing prerequisite.', false, 'Run `ft app doctor`.'); } },
    });
    const worker = new DurableJobWorker({ repository, workerId: 'fixture-worker', handlers: orchestrator.handlers() });
    await worker.runOnce();
    const [job] = await repository.listJobs(page.item.canonicalId);
    assert.equal(job.state, 'blocked');
    assert.equal(job.lastErrorCode, code);
    await repository.close();
  }
});
