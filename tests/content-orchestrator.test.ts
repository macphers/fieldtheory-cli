import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import fixture from './fixtures/knowledge-page-youtube.json' with { type: 'json' };
import { buildKnowledgePageArtifact, normalizeTranscript, type KnowledgePageFixtureInput } from '../src/content/knowledge-page.js';
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

test('enriched X articles enter the chapters-to-summary pipeline without media tooling', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fieldtheory-article-orchestrator-'));
  const repository = await SqlJsContentRepository.open(path.join(dir, 'content.sqlite'));
  const model = {
    provider: 'fixture',
    generate: async () => JSON.stringify({
      overview: [
        { text: 'The article explains a durable idea.', citations: [{ startMs: 0, endMs: 2_000 }] },
        { text: 'The idea is framed for long-term use.', citations: [{ startMs: 0, endMs: 2_000 }] },
        { text: 'A practical mechanism makes the idea concrete.', citations: [{ startMs: 2_000, endMs: 4_000 }] },
      ],
      details: [{ text: 'A practical mechanism makes the idea concrete.', citations: [{ startMs: 2_000, endMs: 4_000 }] }],
    }),
    checkSupport: async () => 'supported' as const,
  };
  const orchestrator = new ContentOrchestrator({
    repository,
    metadataProvider: { acquireMetadata: async () => { throw new Error('Article discovery must not call yt-dlp metadata.'); } },
    transcriptPipeline: { acquire: async () => { throw new Error('Article discovery must not call media transcription.'); } },
    model,
    now: () => new Date('2026-08-12T20:00:00.000Z'),
  });
  try {
    const bookmark: BookmarkRecord = {
      id: 'article-1', tweetId: 'article-1', url: 'https://x.com/example/article/1', text: 'Preview', syncedAt: '2026-08-12T20:00:00.000Z',
      articleTitle: 'A Durable Idea', articleText: 'The article explains a durable idea.\n\nA practical mechanism makes the idea concrete.', authorName: 'Example Author', language: 'en',
    };
    assert.deepEqual(await orchestrator.discover([bookmark]), { discovered: 1, enqueued: 1 });
    const itemId = 'article:x:article-1';
    const item = await repository.getItem(itemId);
    assert.equal(item?.type, 'article');
    assert.equal(item?.videoId, undefined);
    assert.equal((await repository.getTranscript(itemId))?.transcript.provenance.source, 'article-text');
    const worker = new DurableJobWorker({ repository, workerId: 'article-worker', handlers: orchestrator.handlers(), now: () => new Date('2026-08-12T20:00:00.000Z') });
    let completed = 0;
    while (await worker.runOnce()) completed += 1;
    assert.equal(completed, 2);
    const jobs = await repository.listJobs(itemId);
    assert.equal(await repository.itemStatus(itemId, ['chapters', 'summary']), 'ready', JSON.stringify(jobs));
  } finally { await repository.close(); }
});

test('feed-backed podcasts run metadata, publisher transcript, chapters, and summary stages', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fieldtheory-podcast-orchestrator-'));
  const repository = await SqlJsContentRepository.open(path.join(dir, 'content.sqlite'));
  const episodeUrl = 'https://serve.podhome.fm/episodepage/FixtureShow/episode-one';
  const transcript = normalizeTranscript('en', { provider: 'podcast-rss', source: 'publisher-transcript' }, [
    { startMs: 0, endMs: 60_000, text: 'The episode introduces a durable question and explains why it matters.' },
    { startMs: 60_000, endMs: 120_000, text: 'The guest describes a practical mechanism with a concrete example.' },
    { startMs: 120_000, endMs: 180_000, text: 'The host summarizes the tradeoff and proposes a next step.' },
  ]);
  const media = { title: 'Episode One', creator: 'Fixture Host', durationMs: 180_000, mediaUrl: 'https://cdn.example/episode-one.mp3', language: 'en', creatorChapters: [{ startMs: 0, endMs: 180_000, label: 'Episode One', source: 'creator' as const }] };
  const model = {
    provider: 'fixture',
    generate: async () => JSON.stringify({
      overview: [
        { text: 'The episode introduces a durable question.', citations: [{ startMs: 0, endMs: 60_000 }] },
        { text: 'A practical mechanism makes the idea concrete.', citations: [{ startMs: 60_000, endMs: 120_000 }] },
        { text: 'The conclusion proposes a next step.', citations: [{ startMs: 120_000, endMs: 180_000 }] },
      ],
      details: [{ text: 'The practical mechanism is explained with an example.', citations: [{ startMs: 60_000, endMs: 120_000 }] }],
    }),
    checkSupport: async () => 'supported' as const,
  };
  let videoCalls = 0;
  const orchestrator = new ContentOrchestrator({
    repository,
    metadataProvider: { acquireMetadata: async () => { videoCalls += 1; throw new Error('Podcast metadata must not use the YouTube provider.'); } },
    transcriptPipeline: { acquire: async () => { videoCalls += 1; throw new Error('Podcast transcripts must not use the YouTube pipeline.'); } },
    podcastPipeline: {
      acquireMetadata: async () => media,
      acquire: async () => ({ media, transcript, artifactPath: path.join(dir, 'podcast.json'), source: 'publisher-transcript' as const }),
    },
    model,
    now: () => new Date('2026-08-12T20:00:00.000Z'),
  });
  try {
    const bookmark: BookmarkRecord = { id: 'podcast-1', tweetId: 'podcast-1', url: 'https://x.com/example/status/1', text: `Listen ${episodeUrl}`, links: [episodeUrl], syncedAt: '2026-08-12T20:00:00.000Z' };
    assert.deepEqual(await orchestrator.discover([bookmark]), { discovered: 1, enqueued: 1 });
    const [item] = await repository.listItems();
    const worker = new DurableJobWorker({ repository, workerId: 'podcast-worker', handlers: orchestrator.handlers(), now: () => new Date('2026-08-12T20:00:00.000Z') });
    let completed = 0;
    while (await worker.runOnce()) completed += 1;
    assert.equal(completed, 4);
    assert.equal(videoCalls, 0);
    assert.equal((await repository.getItem(item.canonicalId))?.mediaUrl, media.mediaUrl);
    assert.equal((await repository.getTranscript(item.canonicalId))?.transcript.provenance.source, 'publisher-transcript');
    assert.equal(await repository.itemStatus(item.canonicalId, ['metadata', 'transcript', 'chapters', 'summary']), 'ready');
  } finally { await repository.close(); }
});
