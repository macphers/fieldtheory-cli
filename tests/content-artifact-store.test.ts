import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import fixture from './fixtures/knowledge-page-youtube.json' with { type: 'json' };
import { normalizeTranscript } from '../src/content/knowledge-page.js';
import { persistTranscriptArtifact, transcriptArtifactHash } from '../src/content/transcripts/artifact-store.js';

test('persists and verifies transcript artifacts by normalized content hash', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fieldtheory-content-artifacts-'));
  const transcript = normalizeTranscript(fixture.transcript.language, fixture.transcript.provenance, fixture.transcript.segments);
  const outputPath = await persistTranscriptArtifact(root, transcript);
  assert.equal(path.basename(outputPath), `${transcript.contentHash}.json`);
  assert.equal(transcriptArtifactHash(transcript), transcript.contentHash);
  const saved = JSON.parse(await readFile(outputPath, 'utf8'));
  assert.equal(saved.contentHash, transcript.contentHash);

  await persistTranscriptArtifact(root, transcript);
  await writeFile(outputPath, JSON.stringify({ ...transcript, contentHash: 'bad' }));
  await assert.rejects(persistTranscriptArtifact(root, transcript), /verification failed/);
});

test('refuses to persist a transcript whose declared hash does not match its payload', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fieldtheory-content-artifacts-'));
  const transcript = normalizeTranscript(fixture.transcript.language, fixture.transcript.provenance, fixture.transcript.segments);
  await assert.rejects(persistTranscriptArtifact(root, { ...transcript, contentHash: 'bad' }), /does not match/);
});
