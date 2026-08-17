import assert from 'node:assert/strict';
import test from 'node:test';

import { countUnresolvedReviewThreads, evaluateReviewGate, loadPullRequestComments } from '../scripts/check-pr-review-gate.mjs';

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

test('review gate paginates all comments and review threads', async () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = 'test-token';
  globalThis.fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as { query: string; variables: { before?: string | null; after?: string | null } };
    const pullRequest = request.query.includes('ReviewGateComments')
      ? { comments: request.variables.before
        ? { nodes: [{ body: '<!-- fieldtheory-codex-review head=oldest -->' }], pageInfo: { hasPreviousPage: false, startCursor: null } }
        : { nodes: [{ body: 'newer comment' }], pageInfo: { hasPreviousPage: true, startCursor: 'comments-page-2' } } }
      : { reviewThreads: request.variables.after
        ? { nodes: [{ isResolved: true }], pageInfo: { hasNextPage: false, endCursor: null } }
        : { nodes: [{ isResolved: false }], pageInfo: { hasNextPage: true, endCursor: 'threads-page-2' } } };
    return new Response(JSON.stringify({ data: { repository: { pullRequest } } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    assert.deepEqual(await loadPullRequestComments('owner', 'repo', 1), ['newer comment', '<!-- fieldtheory-codex-review head=oldest -->']);
    assert.equal(await countUnresolvedReviewThreads('owner', 'repo', 1), 1);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = originalToken;
  }
});
