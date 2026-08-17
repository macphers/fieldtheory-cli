import { createHash } from 'node:crypto';
import path from 'node:path';
import type { BookmarkRecord } from '../types.js';
import { ensureDir, writeJson } from '../fs.js';
import { discoverYouTubeContent } from './discovery.js';
import { normalizeYouTubeUrl } from './youtube.js';
import type {
  KnowledgeClaim,
  KnowledgeClaimInput,
  KnowledgePageArtifact,
  RawChapter,
  RawTranscriptSegment,
  TranscriptArtifact,
  TranscriptProviderProvenance,
} from './types.js';

export interface KnowledgePageFixtureInput {
  bookmark: BookmarkRecord;
  sourceUrl?: string;
  media: {
    title: string;
    creator: string;
    durationMs: number;
    thumbnailUrl?: string;
  };
  transcript: {
    language: string;
    provenance: TranscriptProviderProvenance;
    segments: RawTranscriptSegment[];
  };
  chapters?: RawChapter[];
  synthesis: {
    overview: KnowledgeClaimInput[];
    details: KnowledgeClaimInput[];
  };
  generatedAt: string;
}

function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function requiredText(value: string, name: string): string {
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (!normalized) throw new Error(`${name} must not be empty.`);
  return normalized;
}

function parseGeneratedAt(value: string): string {
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime())) throw new Error('Generated timestamp must be a valid date.');
  return timestamp.toISOString();
}

export function normalizeTranscript(
  language: string,
  provenance: TranscriptProviderProvenance,
  rawSegments: RawTranscriptSegment[],
): TranscriptArtifact {
  if (rawSegments.length === 0) throw new Error('Transcript must contain at least one segment.');

  let previousStart = -1;
  const normalized = rawSegments.map((segment, index) => {
    if (!Number.isInteger(segment.startMs) || !Number.isInteger(segment.endMs)) {
      throw new Error(`Transcript segment ${index} timestamps must be integer milliseconds.`);
    }
    if (segment.startMs < 0 || segment.endMs <= segment.startMs) {
      throw new Error(`Transcript segment ${index} has an invalid time range.`);
    }
    if (segment.startMs < previousStart) {
      throw new Error(`Transcript segment ${index} starts before the previous segment.`);
    }
    previousStart = segment.startMs;
    return {
      startMs: segment.startMs,
      endMs: segment.endMs,
      text: requiredText(segment.text, `Transcript segment ${index} text`),
    };
  });

  const normalizedLanguage = requiredText(language, 'Transcript language').toLowerCase();
  const contentHash = sha256({
    language: normalizedLanguage,
    segmentationVersion: 1,
    segments: normalized,
  });
  return {
    schemaVersion: 1,
    language: normalizedLanguage,
    segmentationVersion: 1,
    contentHash,
    provenance,
    segments: normalized.map((segment) => ({
      ...segment,
      id: sha256({
        transcriptContentHash: contentHash,
        segmentationVersion: 1,
        startMs: segment.startMs,
        endMs: segment.endMs,
      }).slice(0, 24),
    })),
  };
}

export function creatorChaptersAreUsable(chapters: RawChapter[], durationMs: number): boolean {
  if (chapters.length === 0) return false;
  const ordered = [...chapters].sort((a, b) => a.startMs - b.startMs);
  if (ordered.some((chapter) =>
    chapter.source !== 'creator'
    || chapter.startMs < 0
    || chapter.endMs <= chapter.startMs
    || chapter.endMs > durationMs
    || !chapter.label.trim())) {
    return false;
  }
  if (durationMs > 20 * 60_000 && ordered.length < 3) return false;
  if (ordered.some((chapter) => chapter.endMs - chapter.startMs > 30 * 60_000)) return false;
  let coveredMs = 0;
  let coveredUntil = 0;
  for (const chapter of ordered) {
    const uncoveredStart = Math.max(chapter.startMs, coveredUntil);
    coveredMs += Math.max(0, chapter.endMs - uncoveredStart);
    coveredUntil = Math.max(coveredUntil, chapter.endMs);
  }
  return coveredMs / durationMs >= 0.7;
}

export function generatedChaptersAreValid(chapters: RawChapter[], durationMs: number): boolean {
  if (chapters.length === 0) return false;
  return chapters.every((chapter, index) =>
    chapter.source === 'generated'
    && Number.isInteger(chapter.startMs)
    && Number.isInteger(chapter.endMs)
    && chapter.startMs >= 0
    && chapter.endMs > chapter.startMs
    && chapter.endMs <= durationMs
    && chapter.label.trim().length > 0
    && (index === 0 || chapter.startMs >= chapters[index - 1].endMs));
}

export function validateKnowledgeClaims(
  claims: KnowledgeClaimInput[],
  transcript: TranscriptArtifact,
  name: string,
): KnowledgeClaim[] {
  const transcriptEndMs = transcript.segments.at(-1)?.endMs ?? 0;
  return claims.map((claim, claimIndex) => {
    if (claim.citations.length === 0) throw new Error(`${name} claim ${claimIndex} must include at least one citation.`);
    return {
      text: requiredText(claim.text, `${name} claim ${claimIndex}`),
      citations: claim.citations.map((citation, citationIndex) => {
        if (
          !Number.isInteger(citation.startMs)
          || !Number.isInteger(citation.endMs)
          || citation.startMs < 0
          || citation.endMs <= citation.startMs
          || citation.endMs > transcriptEndMs
        ) {
          throw new Error(`${name} claim ${claimIndex} citation ${citationIndex} has an invalid time range.`);
        }
        const segmentIds = transcript.segments
          .filter((segment) => segment.endMs > citation.startMs && segment.startMs < citation.endMs)
          .map((segment) => segment.id);
        if (segmentIds.length === 0) {
          throw new Error(`${name} claim ${claimIndex} citation ${citationIndex} does not resolve to transcript segments.`);
        }
        return {
          transcriptContentHash: transcript.contentHash,
          startMs: citation.startMs,
          endMs: citation.endMs,
          segmentIds,
        };
      }),
    };
  });
}

export function buildKnowledgePageArtifact(input: KnowledgePageFixtureInput): KnowledgePageArtifact {
  const discovered = discoverYouTubeContent([input.bookmark]);
  const selectedSource = input.sourceUrl ? normalizeYouTubeUrl(input.sourceUrl) : null;
  const item = input.sourceUrl
    ? discovered.find((candidate) => candidate.canonicalId === selectedSource?.canonicalId)
    : discovered[0];
  if (!item) throw new Error('Bookmark does not contain a supported YouTube URL.');
  if (!Number.isInteger(input.media.durationMs) || input.media.durationMs <= 0) {
    throw new Error('Media duration must be a positive integer in milliseconds.');
  }
  if (input.synthesis.overview.length < 3 || input.synthesis.overview.length > 5) {
    throw new Error('Knowledge page overview must contain 3 to 5 claims.');
  }

  const transcript = normalizeTranscript(
    input.transcript.language,
    input.transcript.provenance,
    input.transcript.segments,
  );
  const chapters = [...(input.chapters ?? [])];
  const usableCreatorChapters = creatorChaptersAreUsable(chapters, input.media.durationMs);
  const validGeneratedChapters = generatedChaptersAreValid(chapters, input.media.durationMs);
  if (chapters.some((chapter) => chapter.source === 'generated') && !validGeneratedChapters) {
    throw new Error('Generated chapters must be ordered, non-overlapping, bounded, and non-empty.');
  }
  const chapterStatus = usableCreatorChapters
    ? 'creator'
    : validGeneratedChapters
      ? 'generated'
      : 'needs-generation';
  const artifactChapters = chapterStatus === 'creator'
    ? chapters.sort((a, b) => a.startMs - b.startMs)
    : chapterStatus === 'generated'
      ? chapters
      : [];

  return {
    schemaVersion: 1,
    generatedAt: parseGeneratedAt(input.generatedAt),
    item: {
      ...item,
      title: requiredText(input.media.title, 'Media title'),
      creator: requiredText(input.media.creator, 'Media creator'),
      durationMs: input.media.durationMs,
      ...(input.media.thumbnailUrl ? { thumbnailUrl: input.media.thumbnailUrl } : {}),
    },
    transcript,
    chapters: artifactChapters,
    chapterStatus,
    overview: validateKnowledgeClaims(input.synthesis.overview, transcript, 'Overview'),
    details: validateKnowledgeClaims(input.synthesis.details, transcript, 'Details'),
  };
}

export async function writeKnowledgePageArtifact(
  outputDir: string,
  artifact: KnowledgePageArtifact,
): Promise<string> {
  await ensureDir(outputDir);
  const outputPath = path.join(outputDir, `${artifact.item.videoId}.knowledge-page.json`);
  await writeJson(outputPath, artifact);
  return outputPath;
}
