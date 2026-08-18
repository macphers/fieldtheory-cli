export type ItemStatus = 'discovered' | 'processing' | 'ready' | 'failed' | 'blocked' | 'cancelled';

export interface SourceRef {
  bookmarkId: string;
  bookmarkUrl: string;
  sourceUrl: string;
  discoveredAt: string;
}

export interface KnowledgeItem {
  canonicalId: string;
  videoId: string;
  canonicalUrl: string;
  title: string;
  creator: string;
  durationMs: number;
  thumbnailUrl?: string;
  language?: string;
  status: ItemStatus;
  sourceRefs: SourceRef[];
  note?: { markdown: string; version: number } | null;
  jobs?: Array<{ id: string; stage: string; state: string; lastErrorCode?: string; lastErrorDetail?: string }>;
  chapters?: Array<{ startMs: number; endMs: number; label: string }>;
  overview?: Array<{ text: string; citations: Array<{ startMs: number; endMs: number }> }>;
  details?: Array<{ text: string; citations: Array<{ startMs: number; endMs: number }> }>;
}

export interface TranscriptSegment {
  id: string;
  startMs: number;
  endMs: number;
  text: string;
}

export interface ContentSearchHit {
  item: KnowledgeItem;
  matchType: 'metadata' | 'summary' | 'transcript';
  excerpt: string;
  rank: number;
  segmentId?: string;
  startMs?: number;
  endMs?: number;
}

export interface ChatAnswer {
  answer: string;
  citations: Array<{ segmentId: string; startMs: number; endMs: number }>;
  refused: boolean;
}
