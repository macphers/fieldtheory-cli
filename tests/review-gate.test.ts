import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluateReviewGate } from '../scripts/check-pr-review-gate.mjs';

test('review gate passes when the current commit was reviewed and threads are resolved', () => {
  const result = evaluateReviewGate({
    comments: ['<!-- fieldtheory-codex-review head=abc123 -->'],
    headSha: 'abc123',
    requireCodexReview: true,
    unresolvedThreads: 0,
  });
  assert.deepEqual(result, { failures: [], latestCommitReviewed: true });
});

test('review gate rejects a stale review marker when Codex review is required', () => {
  const result = evaluateReviewGate({
    comments: ['<!-- fieldtheory-codex-review head=old123 -->'],
    headSha: 'new456',
    requireCodexReview: true,
    unresolvedThreads: 0,
  });
  assert.match(result.failures[0] ?? '', /latest PR commit/);
});

test('review gate rejects unresolved threads even in advisory mode', () => {
  const result = evaluateReviewGate({
    comments: [],
    headSha: 'abc123',
    requireCodexReview: false,
    unresolvedThreads: 2,
  });
  assert.deepEqual(result.failures, ['2 review threads remain unresolved.']);
});
