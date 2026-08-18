import { ProcessExecutionError } from '../content/process-runner.js';
import type { ContentRepository } from '../content/repository.js';
import type { ChildJobInput, JobCompletionMutation } from '../content/repository.js';
import { retryDelayMs, type ProcessingJobSnapshot, type ProcessingStage } from './state-machine.js';

export type JobFailureDisposition = 'retry' | 'blocked' | 'failed';

export class JobStageError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly disposition: JobFailureDisposition,
  ) {
    super(message);
    this.name = 'JobStageError';
  }
}

export interface JobStageCompletion {
  children?: ChildJobInput[];
  mutation?: JobCompletionMutation;
}

export type JobStageHandler = (job: ProcessingJobSnapshot, signal: AbortSignal) => Promise<void | JobStageCompletion>;

export interface DurableJobWorkerOptions {
  repository: ContentRepository;
  workerId: string;
  handlers: Partial<Record<ProcessingStage, JobStageHandler>>;
  resourceClass?: import('./state-machine.js').JobResourceClass;
  now?: () => Date;
  random?: () => number;
  leaseMs?: number;
  renewEveryMs?: number;
  maxAttempts?: number;
}

export class DurableJobWorker {
  private readonly now: () => Date;
  private readonly random: () => number;
  private readonly leaseMs: number;
  private readonly renewEveryMs: number;
  private readonly maxAttempts: number;
  private current: { job: ProcessingJobSnapshot; controller: AbortController; abortKind: 'shutdown' | 'cancel' | null } | null = null;

  constructor(private readonly options: DurableJobWorkerOptions) {
    this.now = options.now ?? (() => new Date());
    this.random = options.random ?? Math.random;
    this.leaseMs = options.leaseMs ?? 60_000;
    this.renewEveryMs = options.renewEveryMs ?? 20_000;
    this.maxAttempts = options.maxAttempts ?? 5;
  }

  async runOnce(): Promise<boolean> {
    if (this.current) throw new Error('Worker is already processing a job.');
    const leased = await this.options.repository.leaseNextJob(this.options.workerId, this.now().toISOString(), this.leaseMs, this.options.resourceClass);
    if (!leased) return false;
    const handler = this.options.handlers[leased.stage];
    if (!handler) {
      await this.options.repository.transitionJob(leased.id, {
        state: 'blocked', now: this.now().toISOString(), errorCode: 'handler_missing',
        errorDetail: `No worker handler is registered for ${leased.stage}.`,
        lease: { workerId: this.options.workerId, token: leased.leaseToken },
      });
      return true;
    }

    const controller = new AbortController();
    this.current = { job: leased, controller, abortKind: null };
    const renewal = setInterval(() => {
      void this.options.repository.renewJobLease(leased.id, this.options.workerId, leased.leaseToken, this.now().toISOString(), this.leaseMs).catch(() => controller.abort());
    }, this.renewEveryMs);
    renewal.unref();

    try {
      const completion = await handler(leased, controller.signal);
      if (controller.signal.aborted) throw controller.signal.reason ?? new Error('Worker stopped.');
      await this.options.repository.completeJob(
        leased.id,
        { state: 'succeeded', now: this.now().toISOString(), lease: { workerId: this.options.workerId, token: leased.leaseToken } },
        completion?.children,
        completion?.mutation,
      );
    } catch (error) {
      const now = this.now().toISOString();
      if (this.current.abortKind === 'cancel') {
        await this.options.repository.transitionJob(leased.id, { state: 'cancelled', now, errorCode: 'cancelled_by_user', errorDetail: 'Cancelled by the user.', lease: { workerId: this.options.workerId, token: leased.leaseToken } });
      } else if (this.current.abortKind === 'shutdown' || controller.signal.aborted || (error instanceof ProcessExecutionError && error.reason === 'aborted')) {
        await this.options.repository.transitionJob(leased.id, { state: 'interrupted', now, errorCode: 'worker_stopped', errorDetail: 'Worker stopped before the stage completed.', lease: { workerId: this.options.workerId, token: leased.leaseToken } });
        await this.options.repository.retryJob(leased.id, now);
      } else if (error instanceof JobStageError && error.disposition === 'blocked') {
        await this.options.repository.transitionJob(leased.id, { state: 'blocked', now, errorCode: error.code, errorDetail: error.message, lease: { workerId: this.options.workerId, token: leased.leaseToken } });
      } else if (error instanceof JobStageError && error.disposition === 'retry' && leased.attemptCount < this.maxAttempts) {
        const nextRetryAt = new Date(Date.parse(now) + retryDelayMs(leased.attemptCount, this.random)).toISOString();
        await this.options.repository.transitionJob(leased.id, { state: 'retry_wait', now, nextRetryAt, errorCode: error.code, errorDetail: error.message, lease: { workerId: this.options.workerId, token: leased.leaseToken } });
      } else {
        await this.options.repository.transitionJob(leased.id, {
          state: 'failed', now,
          errorCode: error instanceof JobStageError ? error.code : 'unexpected_error',
          errorDetail: error instanceof Error ? error.message : String(error),
          lease: { workerId: this.options.workerId, token: leased.leaseToken },
        });
      }
    } finally {
      clearInterval(renewal);
      this.current = null;
    }
    return true;
  }

  stop(): void {
    if (!this.current) return;
    this.current.abortKind = 'shutdown';
    this.current.controller.abort();
  }

  cancelCurrent(): void {
    if (!this.current) return;
    this.current.abortKind = 'cancel';
    this.current.controller.abort();
  }

  currentJob(): ProcessingJobSnapshot | null {
    return this.current?.job ?? null;
  }
}
