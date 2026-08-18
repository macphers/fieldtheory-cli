import { createHash } from 'node:crypto';
import { creatorChaptersAreUsable, generatedChaptersAreValid } from '../knowledge-page.js';
import type { RawChapter, TranscriptArtifact } from '../types.js';
import type { SynthesisModel } from './pipeline.js';

export interface GeneratedChapterSet {
  chapters: RawChapter[];
  artifactHash: string;
  source: 'creator' | 'generated';
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

const MAX_CHAPTER_EVIDENCE_CHARS = 60_000;

export function chapterEvidencePayload(transcript: TranscriptArtifact, maxChars = MAX_CHAPTER_EVIDENCE_CHARS): string {
  const records = transcript.segments.map(({ id, startMs, endMs, text }) => ({ id, startMs, endMs, text }));
  const complete = JSON.stringify(records);
  if (complete.length <= maxChars) return complete;

  let target = Math.min(records.length, 240);
  while (target >= 2) {
    const indexes = Array.from({ length: target }, (_, index) => Math.round(index * (records.length - 1) / (target - 1)));
    const sampled = [...new Set(indexes)].map((index) => ({ ...records[index], text: records[index].text.slice(0, 320) }));
    const payload = JSON.stringify(sampled);
    if (payload.length <= maxChars) return payload;
    target = Math.floor(target * 0.8);
  }
  throw new Error(`Transcript cannot fit the configured ${maxChars}-character chapter evidence ceiling.`);
}

function parseGenerated(raw: string, durationMs: number): RawChapter[] {
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('Chapter model did not return a JSON object.');
  const value = JSON.parse(trimmed.slice(start, end + 1)) as { chapters?: unknown };
  if (!Array.isArray(value.chapters)) throw new Error('Chapter output must contain a chapters array.');
  const chapters = value.chapters.map((candidate, index) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw new Error(`Generated chapter ${index} must be an object.`);
    const chapter = candidate as { startMs?: unknown; endMs?: unknown; label?: unknown };
    if (!Number.isInteger(chapter.startMs) || !Number.isInteger(chapter.endMs) || typeof chapter.label !== 'string') throw new Error(`Generated chapter ${index} has an invalid shape.`);
    return { startMs: chapter.startMs as number, endMs: chapter.endMs as number, label: chapter.label.trim(), source: 'generated' as const };
  });
  if (!generatedChaptersAreValid(chapters, durationMs)) throw new Error('Generated chapters must be ordered, non-overlapping, bounded, and non-empty.');
  return chapters;
}

export async function buildChapters(
  transcript: TranscriptArtifact,
  durationMs: number,
  creatorChapters: RawChapter[] | undefined,
  model: SynthesisModel | undefined,
  signal?: AbortSignal,
): Promise<GeneratedChapterSet> {
  if (creatorChapters && creatorChaptersAreUsable(creatorChapters, durationMs)) {
    const chapters = [...creatorChapters].sort((a, b) => a.startMs - b.startMs);
    return { chapters, artifactHash: hash({ transcriptContentHash: transcript.contentHash, chapters }), source: 'creator' };
  }
  if (signal?.aborted) throw signal.reason ?? new Error('Chapter generation cancelled.');
  const effectiveDuration = Math.max(durationMs, transcript.segments.at(-1)?.endMs ?? 1);
  const target = Math.max(1, Math.min(16, Math.ceil(effectiveDuration / (10 * 60_000))));
  const starts = Array.from({ length: target }, (_value, index) => Math.floor(index * effectiveDuration / target));
  const chapters = starts.map((startMs, index) => {
    const endMs = index + 1 < starts.length ? starts[index + 1] : effectiveDuration;
    const evidence = transcript.segments.find((segment) => segment.startMs >= startMs) ?? [...transcript.segments].reverse().find((segment) => segment.startMs <= startMs) ?? transcript.segments[0];
    const label = evidence.text.replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s+/)[0].slice(0, 72) || `Part ${index + 1}`;
    return { startMs, endMs, label, source: 'generated' as const };
  });
  return { chapters, artifactHash: hash({ transcriptContentHash: transcript.contentHash, provider: 'local-extractive-v1', chapters }), source: 'generated' };
}
