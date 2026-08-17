import test from 'node:test';
import assert from 'node:assert/strict';
import fixture from './fixtures/knowledge-page-youtube.json' with { type: 'json' };
import { buildKnowledgePageArtifact, type KnowledgePageFixtureInput } from '../src/content/knowledge-page.js';
import { buildClaimReviewPacket } from '../src/content/review.js';

test('claim review packet includes every claim, timestamped evidence, and verdict controls', () => {
  const artifact = buildKnowledgePageArtifact(structuredClone(fixture) as KnowledgePageFixtureInput);
  const packet = buildClaimReviewPacket([{
    item: { ...artifact.item, createdAt: artifact.generatedAt, updatedAt: artifact.generatedAt },
    transcript: {
      itemId: artifact.item.canonicalId,
      artifactHash: artifact.transcript.contentHash,
      artifactPath: '/private/transcript.json',
      transcript: artifact.transcript,
      acquiredAt: artifact.generatedAt,
    },
    summary: {
      itemId: artifact.item.canonicalId,
      transcriptContentHash: artifact.transcript.contentHash,
      overview: artifact.overview,
      details: artifact.details,
      provider: 'fixture',
      promptVersion: 1,
      artifactHash: 'summary-hash',
      validationState: 'supported',
      createdAt: artifact.generatedAt,
      promotedAt: artifact.generatedAt,
    },
  }], '2026-08-13T12:00:00.000Z');

  assert.match(packet, /Items: 1/);
  assert.match(packet, new RegExp(`Claims: ${artifact.overview.length + artifact.details.length}`));
  assert.match(packet, /Verdict: \[ \] Supported  \[ \] Unsupported  \[ \] Needs edit/);
  assert.match(packet, /## Priority review queue/);
  assert.match(packet, /\[1-O1\]\(#1-o1\)/);
  assert.match(packet, /### 1-O1/);
  assert.match(packet, /### 1-D1/);
  assert.match(packet, /[?&]t=0s/);
  assert.match(packet, /> The opening establishes the central question/);
});
