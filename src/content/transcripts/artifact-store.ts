import { createHash } from 'node:crypto';
import path from 'node:path';
import { readJson, writeJson, ensureDir, pathExists } from '../../fs.js';
import type { TranscriptArtifact } from '../types.js';

function canonicalPayload(artifact: TranscriptArtifact): unknown {
  return {
    language: artifact.language,
    segmentationVersion: artifact.segmentationVersion,
    segments: artifact.segments.map(({ startMs, endMs, text }) => ({ startMs, endMs, text })),
  };
}

export function transcriptArtifactHash(artifact: TranscriptArtifact): string {
  return createHash('sha256').update(JSON.stringify(canonicalPayload(artifact))).digest('hex');
}

export async function persistTranscriptArtifact(rootDir: string, artifact: TranscriptArtifact): Promise<string> {
  const hash = transcriptArtifactHash(artifact);
  if (hash !== artifact.contentHash) throw new Error('Transcript content hash does not match its normalized payload.');
  const outputDir = path.join(rootDir, 'artifacts', 'transcripts');
  const outputPath = path.join(outputDir, `${hash}.json`);
  await ensureDir(outputDir);
  if (!await pathExists(outputPath)) await writeJson(outputPath, artifact);
  const saved = await readJson<TranscriptArtifact>(outputPath);
  if (transcriptArtifactHash(saved) !== hash || saved.contentHash !== hash) {
    throw new Error(`Transcript artifact verification failed for ${hash}.`);
  }
  return outputPath;
}
