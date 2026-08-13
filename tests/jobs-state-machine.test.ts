import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertJobTransition,
  canTransitionJob,
  jobInputFingerprint,
  projectItemStatus,
  retryDelayMs,
  type JobState,
  type ProcessingJobSnapshot,
} from '../src/jobs/state-machine.js';

const states: JobState[] = ['queued', 'running', 'retry_wait', 'succeeded', 'failed', 'blocked', 'cancelled', 'interrupted'];
const legal = new Set(['queued:running', 'running:succeeded', 'running:retry_wait', 'running:failed', 'running:blocked', 'running:cancelled', 'running:interrupted', 'retry_wait:queued', 'failed:queued', 'blocked:queued', 'cancelled:queued', 'interrupted:queued']);

test('defines every legal transition explicitly and rejects every other pair', () => {
  for (const from of states) for (const to of states) {
    assert.equal(canTransitionJob(from, to), legal.has(`${from}:${to}`), `${from} -> ${to}`);
    if (legal.has(`${from}:${to}`)) assert.doesNotThrow(() => assertJobTransition(from, to));
    else assert.throws(() => assertJobTransition(from, to), /Illegal processing job transition/);
  }
});

test('input fingerprints are stable, ordered, and stage-version specific', () => {
  const base = jobInputFingerprint('youtube:id', 'summary', ['transcript', 'chapters'], 1);
  assert.equal(base, jobInputFingerprint('youtube:id', 'summary', ['transcript', 'chapters'], 1));
  assert.notEqual(base, jobInputFingerprint('youtube:id', 'summary', ['chapters', 'transcript'], 1));
  assert.notEqual(base, jobInputFingerprint('youtube:id', 'summary', ['transcript', 'chapters'], 2));
  assert.notEqual(base, jobInputFingerprint('youtube:id', 'transcript', ['transcript', 'chapters'], 1));
});

test('status projection prioritizes active work, cancellation, blocking, and failure', () => {
  const job = (state: JobState, stage: ProcessingJobSnapshot['stage']): ProcessingJobSnapshot => ({
    id: `${stage}-${state}`, itemId: 'youtube:id', stage, inputFingerprint: 'input', implementationVersion: 1,
    state, attemptCount: 1, createdAt: '2026-08-12T20:00:00.000Z', updatedAt: '2026-08-12T20:00:00.000Z',
  });
  assert.equal(projectItemStatus([], ['metadata']), 'discovered');
  assert.equal(projectItemStatus([job('queued', 'metadata')], ['metadata']), 'processing');
  assert.equal(projectItemStatus([job('cancelled', 'metadata')], ['metadata']), 'cancelled');
  assert.equal(projectItemStatus([job('blocked', 'metadata')], ['metadata']), 'blocked');
  assert.equal(projectItemStatus([job('failed', 'metadata')], ['metadata']), 'failed');
  assert.equal(projectItemStatus([job('succeeded', 'metadata'), job('succeeded', 'transcript')], ['metadata', 'transcript']), 'ready');
});

test('retry delays use capped exponential backoff with bounded jitter', () => {
  assert.equal(retryDelayMs(1, () => 0), 750);
  assert.equal(retryDelayMs(2, () => 1), 2500);
  assert.equal(retryDelayMs(99, () => 1), 375000);
});
