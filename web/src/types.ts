export type ItemStatus = 'discovered' | 'processing' | 'ready' | 'failed' | 'blocked' | 'cancelled';

export interface SourceRef {
  bookmarkId: string;
  bookmarkUrl: string;
  sourceUrl: string;
  discoveredAt: string;
}

export interface KnowledgeItem {
  type: 'youtube' | 'article' | 'podcast';
  canonicalId: string;
  videoId?: string;
  mediaUrl?: string;
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
  capabilities?: Partial<Record<'text' | 'summary' | 'chat' | 'embedding' | 'topics', boolean>>;
  lifecycle?: 'new' | 'seen' | 'kept' | 'dismissed' | 'applied' | 'archived';
  topicIds?: string[];
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

export interface RelatedContentHit {
  item: KnowledgeItem;
  score: number;
  sharedTerms: string[];
}

export interface ChatAnswer {
  answer: string;
  citations: Array<{ segmentId: string; startMs: number; endMs: number }>;
  refused: boolean;
}

export interface MemoryEvidence {
  sourceId?: string;
  sourceTitle: string;
  preview: string;
  sourceUrl?: string;
  segmentId?: string;
  startMs?: number;
  location?: string;
  reason?: string;
}

export interface TodayMemory {
  id: string;
  kind: 'newly_ready' | 'prior_memory' | 'evolving_topic' | 'weekly_synthesis';
  label: string;
  title: string;
  whyNow: string;
  provenance: 'authored' | 'generated' | 'source';
  evidence: MemoryEvidence[];
  itemId?: string;
  topicId?: string;
}

export interface MemoryTopic {
  id: string;
  label: string;
  description?: string;
  confidence?: number;
  itemCount: number;
  recentChange?: string;
  representativeTerms?: string[];
  itemIds?: string[];
}

export interface MemoryConnection {
  id: string;
  fromId: string;
  fromTitle: string;
  toId: string;
  toTitle: string;
  relation: 'supports' | 'contradicts' | 'extends' | 'example-of' | 'derived-from' | 'relevant-to-project' | 'related';
  explanation: string;
  confidence?: number;
  evidence: MemoryEvidence[];
  provenance?: 'authored' | 'generated';
}

export interface CorpusAnswer {
  answer: string;
  claims?: Array<{ heading?: string; text: string; evidence: MemoryEvidence[] }>;
  evidence: MemoryEvidence[];
  refused?: boolean;
  partial?: boolean;
}

export interface CaptureReceipt {
  id?: string;
  state: 'added' | 'resolving' | 'recognized' | 'preparing' | 'useful' | 'duplicate' | 'unsupported' | 'needs_access';
  message: string;
  itemId?: string;
  originalUrl: string;
}

export interface SyncHealth {
  state: 'idle' | 'syncing' | 'stale' | 'auth_expired' | 'error';
  lastSuccessAt?: string;
  nextAttemptAt?: string;
  message?: string;
}
