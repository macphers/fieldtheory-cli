import type { DiscoveredContentItem, TranscriptArtifact } from './types.js';
import type { ItemProcessingStatus, JobState, ProcessingJobSnapshot, ProcessingStage } from '../jobs/state-machine.js';

export interface StoredContentItem extends DiscoveredContentItem {
  title: string;
  creator: string;
  durationMs: number;
  thumbnailUrl?: string;
  language?: string;
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

export interface JobTransitionInput {
  state: JobState;
  now: string;
  nextRetryAt?: string;
  errorCode?: string;
  errorDetail?: string;
}

export interface ContentRepository {
  upsertItem(item: StoredContentItem): Promise<void>;
  getItem(itemId: string): Promise<StoredContentItem | null>;
  listItems(limit?: number, offset?: number): Promise<StoredContentItem[]>;
  saveTranscript(record: TranscriptRecord): Promise<void>;
  getTranscript(itemId: string): Promise<TranscriptRecord | null>;
  searchTranscript(itemId: string, query: string, limit?: number): Promise<TranscriptSearchHit[]>;
  putNote(itemId: string, markdown: string, expectedVersion: number | null, now: string): Promise<ItemNote>;
  getNote(itemId: string): Promise<ItemNote | null>;
  enqueueJob(itemId: string, stage: ProcessingStage, inputFingerprint: string, implementationVersion: number, now: string): Promise<ProcessingJobSnapshot>;
  leaseNextJob(workerId: string, now: string, leaseMs?: number): Promise<ProcessingJobSnapshot | null>;
  renewJobLease(jobId: string, workerId: string, now: string, leaseMs?: number): Promise<ProcessingJobSnapshot>;
  transitionJob(jobId: string, input: JobTransitionInput): Promise<ProcessingJobSnapshot>;
  retryJob(jobId: string, now: string): Promise<ProcessingJobSnapshot>;
  listJobs(itemId?: string): Promise<ProcessingJobSnapshot[]>;
  itemStatus(itemId: string, requiredStages: readonly ProcessingStage[]): Promise<ItemProcessingStatus>;
  recoverExpiredLeases(now: string): Promise<number>;
  recordActivity(event: ActivityEvent): Promise<boolean>;
  setActivityEnabled(enabled: boolean): Promise<void>;
  isActivityEnabled(): Promise<boolean>;
  clearActivity(): Promise<number>;
  checkpoint(): Promise<void>;
  close(): Promise<void>;
}
