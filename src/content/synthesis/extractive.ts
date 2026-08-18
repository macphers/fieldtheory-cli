import { createHash } from 'node:crypto';
import type { KnowledgeClaim, RawChapter, TranscriptArtifact } from '../types.js';

function claim(transcript: TranscriptArtifact, segmentIndex: number): KnowledgeClaim {
  const segment = transcript.segments[Math.max(0, Math.min(segmentIndex, transcript.segments.length - 1))];
  const text = segment.text.replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s+/).slice(0, 2).join(' ').slice(0, 320);
  return { text, citations: [{ transcriptContentHash: transcript.contentHash, startMs: segment.startMs, endMs: segment.endMs, segmentIds: [segment.id] }] };
}

function sampledIndexes(length: number, count: number): number[] {
  if (length <= 0) return [];
  const sampleCount = Math.min(length, count);
  return [...new Set(Array.from({ length: sampleCount }, (_value, index) => Math.round(index * (length - 1) / Math.max(1, sampleCount - 1))))];
}

export function buildExtractiveSummary(transcript: TranscriptArtifact, chapters: RawChapter[], now = new Date()): { overview: KnowledgeClaim[]; details: KnowledgeClaim[]; artifactHash: string; createdAt: string } {
  if (transcript.segments.length === 0) throw new Error('Cannot summarize an empty transcript.');
  const overview = sampledIndexes(transcript.segments.length, 4).map((index) => claim(transcript, index));
  const chapterIndexes = chapters.map((chapter) => transcript.segments.findIndex((segment) => segment.endMs >= chapter.startMs)).filter((index) => index >= 0);
  const details = [...new Set([...chapterIndexes, ...sampledIndexes(transcript.segments.length, 10)])].slice(0, 12).map((index) => claim(transcript, index));
  const createdAt = now.toISOString();
  const artifactHash = createHash('sha256').update(JSON.stringify({ provider: 'local-extractive-v1', transcriptContentHash: transcript.contentHash, overview, details })).digest('hex');
  return { overview, details, artifactHash, createdAt };
}
