import type { DiscoveredContentItem, KnowledgeClaim, KnowledgeClaimInput, RawChapter, TranscriptArtifact } from './types.js';
import type { ItemProcessingStatus, JobEnqueueOptions, JobResourceClass, JobState, ProcessingJobSnapshot, ProcessingStage } from '../jobs/state-machine.js';

export interface StoredContentItem extends DiscoveredContentItem {
  title: string;
  creator: string;
  durationMs: number;
  thumbnailUrl?: string;
  language?: string;
  creatorChapters?: RawChapter[];
  createdAt: string;
  updatedAt: string;
}

export interface TranscriptRecord {
  itemId: string;
  artifactHash: string;
  artifactPath: string;
  transcript: TranscriptArtifact;
  acquiredAt: string;
}

export interface TranscriptSearchHit {
  segmentId: string;
  startMs: number;
  endMs: number;
  text: string;
  rank: number;
}

export interface ContentSearchHit {
  item: StoredContentItem;
  matchType: 'metadata' | 'summary' | 'transcript';
  excerpt: string;
  rank: number;
  segmentId?: string;
  startMs?: number;
  endMs?: number;
}

export interface RelatedContentHit {
  item: StoredContentItem;
  score: number;
  sharedTerms: string[];
}

export interface ChapterRecord {
  itemId: string;
  transcriptContentHash: string;
  artifactHash: string;
  chapters: RawChapter[];
  generation?: Record<string, unknown>;
}

export interface SummaryRecord {
  itemId: string;
  transcriptContentHash: string;
  chaptersArtifactHash?: string;
  overview: KnowledgeClaim[];
  details: KnowledgeClaim[];
  provider: string;
  model?: string;
  promptVersion: number;
  artifactHash: string;
  validationState: 'supported';
  createdAt: string;
  promotedAt: string;
}

export interface SynthesisChunkRecord {
  artifactId: string;
  itemId: string;
  transcriptContentHash: string;
  chunkId: string;
  provider: string;
  model?: string;
  promptVersion: number;
  draft: { overview: KnowledgeClaimInput[]; details: KnowledgeClaimInput[]; chapters?: RawChapter[] };
  artifactHash: string;
  createdAt: string;
}

export interface ItemNote {
  itemId: string;
  markdown: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface ActivityEvent {
  id: string;
  itemId: string;
  type: 'item_opened' | 'citation_clicked' | 'note_saved' | 'question_asked';
  metadata?: Record<string, string | number | boolean>;
  createdAt: string;
}

export interface KnowledgeActivityReport {
  totalEvents: number;
  byType: Record<ActivityEvent['type'], number>;
  items: Array<{ itemId: string; title: string; opens: number; citationClicks: number; notes: number; questions: number; lastActivityAt: string }>;
  habitTrial: {
    firstActivityAt: string | null;
    lastActivityAt: string | null;
    spanDays: number;
    activeDays: number;
    revisitedPages: number;
    requiredSpanDays: 7;
    requiredRevisitedPages: 3;
    met: boolean;
  };
}

export interface ItemDeletionManifest {
  itemId: string;
  title: string;
  sourceRefs: number;
  transcriptSegments: number;
  summaries: number;
  chapters: number;
  jobs: number;
  attempts: number;
  activityEvents: number;
  hasNote: boolean;
  artifactPaths: string[];
}

export interface JobTransitionInput {
  state: JobState;
  now: string;
  nextRetryAt?: string;
  errorCode?: string;
  errorDetail?: string;
  lease?: { workerId: string; token: number };
}

export interface ContentCapabilities {
  metadata: boolean;
  text: boolean;
  exactSearch: boolean;
  chapters: boolean;
  summary: boolean;
  chat: boolean;
  semantic: boolean;
  clustered: boolean;
}

export interface ChildJobInput {
  stage: ProcessingStage;
  inputFingerprint: string;
  implementationVersion: number;
  options?: JobEnqueueOptions;
}

export interface JobLeaseFence {
  jobId: string;
  workerId: string;
  token: number;
}

export type JobCompletionMutation =
  | { kind: 'metadata'; item: StoredContentItem }
  | { kind: 'transcript'; item: StoredContentItem; transcript: TranscriptRecord }
  | { kind: 'chapters'; chapters: ChapterRecord }
  | { kind: 'summary'; summary: SummaryRecord };

export interface ContentRepository {
  upsertItem(item: StoredContentItem): Promise<void>;
  getItem(itemId: string): Promise<StoredContentItem | null>;
  listItems(limit?: number, offset?: number): Promise<StoredContentItem[]>;
  saveTranscript(record: TranscriptRecord, fence?: JobLeaseFence): Promise<void>;
  getTranscript(itemId: string): Promise<TranscriptRecord | null>;
  searchTranscript(itemId: string, query: string, limit?: number): Promise<TranscriptSearchHit[]>;
  searchContent(query: string, limit?: number): Promise<ContentSearchHit[]>;
  relatedContent(itemId: string, limit?: number): Promise<RelatedContentHit[]>;
  replaceChapters(record: ChapterRecord, fence?: JobLeaseFence): Promise<void>;
  getChapters(itemId: string): Promise<ChapterRecord | null>;
  saveSummary(record: SummaryRecord, fence?: JobLeaseFence): Promise<void>;
  getSummary(itemId: string): Promise<SummaryRecord | null>;
  getSynthesisChunk(artifactId: string): Promise<SynthesisChunkRecord | null>;
  saveSynthesisChunk(record: SynthesisChunkRecord): Promise<void>;
  putNote(itemId: string, markdown: string, expectedVersion: number | null, now: string): Promise<ItemNote>;
  getNote(itemId: string): Promise<ItemNote | null>;
  enqueueJob(itemId: string, stage: ProcessingStage, inputFingerprint: string, implementationVersion: number, now: string, options?: JobEnqueueOptions): Promise<ProcessingJobSnapshot>;
  leaseNextJob(workerId: string, now: string, leaseMs?: number, resourceClass?: JobResourceClass): Promise<ProcessingJobSnapshot | null>;
  renewJobLease(jobId: string, workerId: string, leaseToken: number, now: string, leaseMs?: number): Promise<ProcessingJobSnapshot>;
  transitionJob(jobId: string, input: JobTransitionInput): Promise<ProcessingJobSnapshot>;
  completeJob(jobId: string, input: JobTransitionInput & { state: 'succeeded'; lease: { workerId: string; token: number } }, children?: ChildJobInput[], mutation?: JobCompletionMutation): Promise<ProcessingJobSnapshot>;
  retryJob(jobId: string, now: string): Promise<ProcessingJobSnapshot>;
  cancelJob(jobId: string, now: string): Promise<ProcessingJobSnapshot>;
  listJobs(itemId?: string): Promise<ProcessingJobSnapshot[]>;
  itemStatus(itemId: string, requiredStages: readonly ProcessingStage[]): Promise<ItemProcessingStatus>;
  itemCapabilities(itemId: string): Promise<ContentCapabilities>;
  recoverExpiredLeases(now: string): Promise<number>;
  setLongTranscriptionOverride(itemId: string, enabled: boolean): Promise<void>;
  hasLongTranscriptionOverride(itemId: string): Promise<boolean>;
  recordActivity(event: ActivityEvent): Promise<boolean>;
  setActivityEnabled(enabled: boolean): Promise<void>;
  isActivityEnabled(): Promise<boolean>;
  clearActivity(): Promise<number>;
  activityCount(): Promise<number>;
  activityReport(): Promise<KnowledgeActivityReport>;
  deletionManifest(itemId: string): Promise<ItemDeletionManifest | null>;
  deleteItem(itemId: string): Promise<ItemDeletionManifest>;
  checkpoint(): Promise<void>;
  close(): Promise<void>;
}
