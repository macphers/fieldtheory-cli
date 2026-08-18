import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import fixture from './fixtures/knowledge-page-youtube.json' with { type: 'json' };
import { SqlJsContentRepository } from '../src/content/sqljs-repository.js';
import { buildKnowledgePageArtifact, normalizeTranscript, type KnowledgePageFixtureInput } from '../src/content/knowledge-page.js';
import type { StoredContentItem } from '../src/content/repository.js';
import { MemoryService } from '../src/memory/service.js';

const NOW = '2026-08-18T20:00:00.000Z';

async function setup() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fieldtheory-memory-'));
  const repository = await SqlJsContentRepository.open(path.join(dir, 'content.sqlite'));
  const artifact = buildKnowledgePageArtifact(structuredClone(fixture) as KnowledgePageFixtureInput);
  const item: StoredContentItem = { ...artifact.item, language: artifact.transcript.language, createdAt: NOW, updatedAt: NOW };
  await repository.upsertItem(item);
  await repository.saveTranscript({ itemId: item.canonicalId, artifactHash: artifact.transcript.contentHash, artifactPath: '/fixture.json', transcript: artifact.transcript, acquiredAt: NOW });
  const related: StoredContentItem = { ...item, canonicalId: 'youtube:related-memory', videoId: 'relatedMemory', canonicalUrl: 'https://www.youtube.com/watch?v=relatedMemory', title: 'A Practical Mechanism for Better Systems', sourceRefs: [] };
  const transcript = normalizeTranscript('en', artifact.transcript.provenance, [{ startMs: 0, endMs: 10_000, text: 'A practical mechanism uses evidence and examples to improve systems.' }]);
  await repository.upsertItem(related);
  await repository.saveTranscript({ itemId: related.canonicalId, artifactHash: transcript.contentHash, artifactPath: '/related.json', transcript, acquiredAt: NOW });
  const memory = new MemoryService(repository, { statePath: path.join(dir, 'memory-state.json'), now: () => new Date(NOW) });
  return { repository, memory, item, related };
}

test('today is bounded, capability-derived, and lifecycle feedback persists', async () => {
  const { repository, memory, item } = await setup();
  try {
    const first = await memory.today(1);
    assert.equal(first.length, 1);
    assert.equal(first[0].capabilities.text, true);
    await memory.setLifecycle(item.canonicalId, 'dismissed');
    assert.ok((await memory.today(3)).every((card) => card.item.canonicalId !== item.canonicalId));
  } finally { await repository.close(); }
});

test('topics and connections are explainable and deterministic', async () => {
  const { repository, memory } = await setup();
  try {
    const topics = await memory.topics();
    assert.ok(topics.some((topic) => topic.itemCount >= 2));
    const connections = await memory.connections();
    assert.equal(connections.length, 1);
    assert.ok(connections[0].sharedTerms.length > 0);
    assert.match(connections[0].explanation, /Connected by/);
    await memory.recordFeedback(connections[0].id, 'wrong');
    assert.deepEqual(await memory.connections(), []);
  } finally { await repository.close(); }
});

test('corpus ask refuses unsupported synthesis and preserves citations in degraded mode', async () => {
  const { repository, memory } = await setup();
  try {
    const answer = await memory.ask('practical mechanism');
    assert.equal(answer.refused, true);
    assert.ok(answer.citations.some((citation) => citation.kind === 'passage'));
  } finally { await repository.close(); }
});
