export interface YouTubeSource {
  videoId: string;
  canonicalId: `youtube:${string}`;
  canonicalUrl: string;
}

export type ContentType = 'youtube' | 'article' | 'podcast';

export interface ContentSourceRef {
  bookmarkId: string;
  bookmarkUrl: string;
  discoveredAt: string;
  sourceUrl: string;
}

export interface DiscoveredContentItem {
  canonicalId: `${ContentType}:${string}`;
  canonicalUrl: string;
  type: ContentType;
  videoId?: string;
  mediaUrl?: string;
  sourceText?: string;
  sourceTitle?: string;
  sourceCreator?: string;
  sourceLanguage?: string;
  sourceRefs: ContentSourceRef[];
}

export interface TranscriptProviderProvenance {
  provider: string;
  toolVersion?: string;
  source: 'creator-captions' | 'automatic-captions' | 'publisher-transcript' | 'local-transcription' | 'article-text';
}

export interface RawTranscriptSegment {
  startMs: number;
  endMs: number;
  text: string;
}

export interface TranscriptSegment extends RawTranscriptSegment {
  id: string;
}

export interface TranscriptArtifact {
  schemaVersion: 1;
  language: string;
  segmentationVersion: 1;
  contentHash: string;
  provenance: TranscriptProviderProvenance;
  segments: TranscriptSegment[];
}

export interface RawChapter {
  startMs: number;
  endMs: number;
  label: string;
  source: 'creator' | 'generated';
}

export interface KnowledgeClaimInput {
  text: string;
  citations: Array<{ startMs: number; endMs: number }>;
}

export interface KnowledgeClaim {
  text: string;
  citations: Array<{
    transcriptContentHash: string;
    startMs: number;
    endMs: number;
    segmentIds: string[];
  }>;
}

export interface KnowledgePageArtifact {
  schemaVersion: 1;
  generatedAt: string;
  item: DiscoveredContentItem & {
    title: string;
    creator: string;
    durationMs: number;
    thumbnailUrl?: string;
  };
  transcript: TranscriptArtifact;
  chapters: RawChapter[];
  chapterStatus: 'creator' | 'generated' | 'needs-generation';
  overview: KnowledgeClaim[];
  details: KnowledgeClaim[];
}
