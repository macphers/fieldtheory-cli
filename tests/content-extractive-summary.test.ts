import test from 'node:test';
import assert from 'node:assert/strict';
import fixture from './fixtures/knowledge-page-youtube.json' with { type: 'json' };
import { buildKnowledgePageArtifact, type KnowledgePageFixtureInput } from '../src/content/knowledge-page.js';
import { buildExtractiveSummary } from '../src/content/synthesis/extractive.js';
import { buildChapters } from '../src/content/synthesis/chapters.js';

test('local extractive summaries are immediately readable and citation-complete', async () => {
  const artifact = buildKnowledgePageArtifact(structuredClone(fixture) as KnowledgePageFixtureInput);
  const chapters = await buildChapters(artifact.transcript, artifact.item.durationMs, undefined, undefined);
  const summary = buildExtractiveSummary(artifact.transcript, chapters.chapters, new Date('2026-08-18T00:00:00.000Z'));
  assert.ok(summary.overview.length > 0);
  assert.ok(summary.details.length >= summary.overview.length);
  for (const claim of [...summary.overview, ...summary.details]) {
    assert.ok(claim.text.length > 0);
    assert.equal(claim.citations.length, 1);
    assert.equal(claim.citations[0].transcriptContentHash, artifact.transcript.contentHash);
    assert.equal(claim.citations[0].segmentIds.length, 1);
  }
});
