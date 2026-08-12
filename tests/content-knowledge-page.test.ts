import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import fixture from './fixtures/knowledge-page-youtube.json' with { type: 'json' };
import {
  buildKnowledgePageArtifact,
  creatorChaptersAreUsable,
  normalizeTranscript,
  writeKnowledgePageArtifact,
  type KnowledgePageFixtureInput,
} from '../src/content/knowledge-page.js';

function input(): KnowledgePageFixtureInput {
  return structuredClone(fixture) as KnowledgePageFixtureInput;
}

test('builds one validated knowledge-page artifact from a bookmark fixture', () => {
  const artifact = buildKnowledgePageArtifact(input());
  assert.equal(artifact.item.canonicalId, 'youtube:dQw4w9WgXcQ');
  assert.equal(artifact.item.sourceRefs.length, 1);
  assert.equal(artifact.chapterStatus, 'creator');
  assert.equal(artifact.overview.length, 3);
  assert.equal(artifact.overview[0].citations[0].transcriptContentHash, artifact.transcript.contentHash);
  assert.equal(artifact.overview[0].citations[0].segmentIds.length, 1);
});

test('selects a requested source by canonical video identity', () => {
  const value = input();
  value.sourceUrl = 'https://youtu.be/dQw4w9WgXcQ?t=42';
  assert.equal(buildKnowledgePageArtifact(value).item.videoId, 'dQw4w9WgXcQ');
});

test('transcript content identity ignores provider provenance but segment IDs remain stable', () => {
  const base = input().transcript;
  const first = normalizeTranscript(base.language, base.provenance, base.segments);
  const second = normalizeTranscript(base.language, {
    ...base.provenance,
    provider: 'new-provider',
    toolVersion: '99.0.0',
  }, base.segments);
  assert.equal(first.contentHash, second.contentHash);
  assert.deepEqual(first.segments.map((segment) => segment.id), second.segments.map((segment) => segment.id));
});

test('rejects citations that do not resolve to transcript evidence', () => {
  const value = input();
  value.synthesis.details[0].citations = [{ startMs: 300000, endMs: 310000 }];
  assert.throws(() => buildKnowledgePageArtifact(value), /invalid time range/);

  const uncited = input();
  uncited.synthesis.overview[0].citations = [];
  assert.throws(() => buildKnowledgePageArtifact(uncited), /at least one citation/);

  const negative = input();
  negative.synthesis.details[0].citations = [{ startMs: -1, endMs: 1000 }];
  assert.throws(() => buildKnowledgePageArtifact(negative), /invalid time range/);

  const pastEnd = input();
  pastEnd.synthesis.details[0].citations = [{ startMs: 170000, endMs: 190000 }];
  assert.throws(() => buildKnowledgePageArtifact(pastEnd), /invalid time range/);
});

test('rejects malformed transcript timing and unsupported bookmarks', () => {
  const malformed = input();
  malformed.transcript.segments[1].startMs = -1;
  assert.throws(() => buildKnowledgePageArtifact(malformed), /invalid time range|starts before/);

  const unsupported = input();
  unsupported.bookmark.links = ['https://example.com/article'];
  unsupported.bookmark.text = 'No video here';
  assert.throws(() => buildKnowledgePageArtifact(unsupported), /supported YouTube URL/);
});

test('applies the deterministic creator-chapter quality policy', () => {
  const chapters = input().chapters!;
  assert.equal(creatorChaptersAreUsable(chapters, 180000), true);
  assert.equal(creatorChaptersAreUsable([
    { startMs: 0, endMs: 600000, label: 'Only chapter', source: 'creator' },
  ], 1_800_000), false);
  assert.equal(creatorChaptersAreUsable([
    { startMs: 0, endMs: 100000, label: 'Overlap one', source: 'creator' },
    { startMs: 0, endMs: 100000, label: 'Overlap two', source: 'creator' },
  ], 180000), false);
});

test('stores accepted creator chapters in chronological order', () => {
  const value = input();
  value.chapters = [...value.chapters!].reverse();
  const artifact = buildKnowledgePageArtifact(value);
  assert.deepEqual(artifact.chapters.map((chapter) => chapter.startMs), [0, 60000, 120000]);
});

test('rejects an invalid generation timestamp with an actionable error', () => {
  const value = input();
  value.generatedAt = 'not-a-date';
  assert.throws(() => buildKnowledgePageArtifact(value), /valid date/);
});

test('writes the validated artifact atomically as JSON', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fieldtheory-knowledge-page-'));
  const artifact = buildKnowledgePageArtifact(input());
  const outputPath = await writeKnowledgePageArtifact(dir, artifact);
  const saved = JSON.parse(await readFile(outputPath, 'utf8'));
  assert.equal(saved.item.canonicalId, artifact.item.canonicalId);
  assert.equal(saved.transcript.contentHash, artifact.transcript.contentHash);
});
