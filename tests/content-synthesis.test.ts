import test from 'node:test';
import assert from 'node:assert/strict';
import fixture from './fixtures/knowledge-page-youtube.json' with { type: 'json' };
import { buildKnowledgePageArtifact, type KnowledgePageFixtureInput } from '../src/content/knowledge-page.js';
import { partitionTranscript, SynthesisPipeline, type SynthesisModel } from '../src/content/synthesis/pipeline.js';
import { normalizeTranscript } from '../src/content/knowledge-page.js';

const artifact = buildKnowledgePageArtifact(structuredClone(fixture) as KnowledgePageFixtureInput);

function draft(extraDetail = ''): string {
  return JSON.stringify({
    overview: [
      { text: 'The opening establishes a practical question.', citations: [{ startMs: 0, endMs: 60000 }] },
      { text: 'The middle explains a concrete mechanism.', citations: [{ startMs: 60000, endMs: 120000 }] },
      { text: 'The ending compares tradeoffs.', citations: [{ startMs: 120000, endMs: 180000 }] },
    ],
    details: [
      { text: 'The mechanism is supported by the middle excerpt.', citations: [{ startMs: 60000, endMs: 120000 }] },
      ...(extraDetail ? [{ text: extraDetail, citations: [{ startMs: 0, endMs: 60000 }] }] : []),
    ],
  });
}

test('partitions long transcripts into overlapping ten-minute windows', () => {
  const transcript = normalizeTranscript('en', { provider: 'fixture', source: 'creator-captions' }, Array.from({ length: 25 }, (_, index) => ({
    startMs: index * 60_000,
    endMs: (index + 1) * 60_000,
    text: `Segment ${index} contains enough distinct words for deterministic transcript testing.`,
  })));
  const chunks = partitionTranscript(transcript);
  assert.equal(chunks.length, 3);
  assert.deepEqual(chunks.map(({ startMs, endMs }) => [startMs, endMs]), [[0, 600000], [570000, 1170000], [1140000, 1500000]]);
  assert.ok(chunks[0].segments.some((segment) => chunks[1].segments.some((next) => next.id === segment.id)));
});

test('synthesis validates structure, citations, support, and deterministic provenance', async () => {
  const model: SynthesisModel = { provider: 'fixture-engine', model: 'fixture-model', generate: async () => draft('Remove this unsupported claim.') };
  const pipeline = new SynthesisPipeline({
    model,
    now: () => new Date('2026-08-12T20:00:00.000Z'),
    checkSupport: async (claim) => claim.text.includes('unsupported') ? 'unsupported' : 'supported',
  });
  const result = await pipeline.synthesize(artifact.transcript, artifact.chapters);
  assert.equal(result.overview.length, 3);
  assert.equal(result.details.length, 1);
  assert.equal(result.provider, 'fixture-engine');
  assert.equal(result.transcriptContentHash, artifact.transcript.contentHash);
  assert.match(result.artifactHash, /^[a-f0-9]{64}$/);
  assert.ok(result.overview.every((claim) => claim.citations.every((citation) => citation.segmentIds.length > 0)));
});

test('synthesis rejects fabricated citations and unsupported overview output', async () => {
  const invalidCitation = new SynthesisPipeline({ model: { provider: 'fixture', generate: async () => JSON.stringify({
    overview: Array.from({ length: 3 }, () => ({ text: 'Fabricated.', citations: [{ startMs: 500000, endMs: 510000 }] })), details: [],
  }) }, checkSupport: async () => 'supported' });
  await assert.rejects(invalidCitation.synthesize(artifact.transcript), /invalid time range/);

  const unsupported = new SynthesisPipeline({ model: { provider: 'fixture', generate: async () => draft() }, checkSupport: async () => 'unsupported' });
  await assert.rejects(unsupported.synthesize(artifact.transcript), /Fewer than three supported/);
});

test('synthesis enforces a pre-dispatch input ceiling', async () => {
  let called = false;
  const pipeline = new SynthesisPipeline({
    model: { provider: 'fixture', generate: async () => { called = true; return draft(); } },
    checkSupport: async () => 'supported',
    maxInputChars: 10,
  });
  await assert.rejects(pipeline.synthesize(artifact.transcript), /character ceiling/);
  assert.equal(called, false);
});
