import { createHash } from 'node:crypto';

export type ProcessingStage = 'metadata' | 'transcript' | 'chapters' | 'summary';
export type JobResourceClass = 'network' | 'model' | 'cpu';
export type JobState = 'queued' | 'running' | 'retry_wait' | 'succeeded' | 'failed' | 'blocked' | 'cancelled' | 'interrupted';
export type ItemProcessingStatus = 'discovered' | 'processing' | 'ready' | 'failed' | 'blocked' | 'cancelled';

export interface ProcessingJobSnapshot {
  id: string;
  itemId: string;
  stage: ProcessingStage;
  inputFingerprint: string;
  implementationVersion: number;
  state: JobState;
  attemptCount: number;
  priority: number;
  resourceClass: JobResourceClass;
  dependsOnJobId?: string;
  leaseToken: number;
  nextRetryAt?: string;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  startedAt?: string;
  lastErrorCode?: string;
  lastErrorDetail?: string;
  createdAt: string;
  updatedAt: string;
}

export interface JobEnqueueOptions {
  priority?: number;
  resourceClass?: JobResourceClass;
  dependsOnJobId?: string;
}

const LEGAL_TRANSITIONS: Record<JobState, readonly JobState[]> = {
  queued: ['running', 'cancelled'],
  running: ['succeeded', 'retry_wait', 'failed', 'blocked', 'cancelled', 'interrupted'],
  retry_wait: ['queued', 'cancelled'],
  succeeded: [],
  failed: ['queued'],
  blocked: ['queued'],
  cancelled: ['queued'],
  interrupted: ['queued'],
};

export function canTransitionJob(from: JobState, to: JobState): boolean {
  return LEGAL_TRANSITIONS[from].includes(to);
}

export function assertJobTransition(from: JobState, to: JobState): void {
  if (!canTransitionJob(from, to)) throw new Error(`Illegal processing job transition: ${from} -> ${to}.`);
}

export function jobInputFingerprint(
  itemId: string,
  stage: ProcessingStage,
  orderedInputHashes: readonly string[],
  implementationVersion: number,
): string {
  return createHash('sha256').update(JSON.stringify({ itemId, stage, orderedInputHashes, implementationVersion })).digest('hex');
}

export function projectItemStatus(jobs: ProcessingJobSnapshot[], requiredStages: readonly ProcessingStage[]): ItemProcessingStatus {
  const required = requiredStages.map((stage) => jobs
    .filter((job) => job.stage === stage)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))[0]);
  if (required.every((job) => job?.state === 'succeeded')) return 'ready';
  if (required.some((job) => job && ['queued', 'running', 'retry_wait', 'interrupted'].includes(job.state))) return 'processing';
  if (required.some((job) => job?.state === 'cancelled')) return 'cancelled';
  if (required.some((job) => job?.state === 'blocked')) return 'blocked';
  if (required.some((job) => job?.state === 'failed')) return 'failed';
  return 'discovered';
}

export function retryDelayMs(attemptCount: number, random = Math.random): number {
  const base = Math.min(5 * 60_000, 1_000 * 2 ** Math.max(0, attemptCount - 1));
  return Math.round(base * (0.75 + random() * 0.5));
}
