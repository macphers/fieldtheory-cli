import process from 'node:process';
import { fileURLToPath } from 'node:url';

const REVIEW_MARKER = '<!-- fieldtheory-codex-review';

export function evaluateReviewGate({ comments, headSha, requireCodexReview, unresolvedThreads }) {
  const latestMarker = `${REVIEW_MARKER} head=${headSha} -->`;
  const latestCommitReviewed = comments.some((body) => body.includes(latestMarker));
  const failures = [];

  if (requireCodexReview && !latestCommitReviewed) {
    failures.push(`Codex has not reviewed the latest PR commit (${headSha}).`);
  }
  if (unresolvedThreads > 0) {
    failures.push(`${unresolvedThreads} review thread${unresolvedThreads === 1 ? '' : 's'} remain unresolved.`);
  }

  return { failures, latestCommitReviewed };
}

async function githubGraphql(query, variables) {
  const response = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${requiredEnvironment('GITHUB_TOKEN')}`,
      'content-type': 'application/json',
      'user-agent': 'fieldtheory-review-gate',
      'x-github-api-version': '2022-11-28',
    },
    body: JSON.stringify({ query, variables }),
  });
  const payload = await response.json();
  if (!response.ok || payload.errors?.length) {
    throw new Error(`GitHub GraphQL request failed: ${JSON.stringify(payload.errors ?? payload)}`);
  }
  return payload.data;
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

export async function loadPullRequestComments(owner, name, number) {
  const comments = [];
  let before = null;
  do {
    const data = await githubGraphql(`
      query ReviewGateComments($owner: String!, $name: String!, $number: Int!, $before: String) {
        repository(owner: $owner, name: $name) {
          pullRequest(number: $number) {
            comments(last: 100, before: $before) {
              nodes { body }
              pageInfo { hasPreviousPage startCursor }
            }
          }
        }
      }
    `, { owner, name, number, before });
    const connection = data.repository?.pullRequest?.comments;
    if (!connection) throw new Error(`Pull request #${number} was not found.`);
    comments.push(...connection.nodes.map((comment) => comment.body));
    before = connection.pageInfo.hasPreviousPage ? connection.pageInfo.startCursor : null;
  } while (before);
  return comments;
}

export async function countUnresolvedReviewThreads(owner, name, number) {
  let unresolved = 0;
  let after = null;
  do {
    const data = await githubGraphql(`
      query ReviewGateThreads($owner: String!, $name: String!, $number: Int!, $after: String) {
        repository(owner: $owner, name: $name) {
          pullRequest(number: $number) {
            reviewThreads(first: 100, after: $after) {
              nodes { isResolved }
              pageInfo { hasNextPage endCursor }
            }
          }
        }
      }
    `, { owner, name, number, after });
    const connection = data.repository?.pullRequest?.reviewThreads;
    if (!connection) throw new Error(`Pull request #${number} was not found.`);
    unresolved += connection.nodes.filter((thread) => !thread.isResolved).length;
    after = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
  } while (after);
  return unresolved;
}

async function main() {
  const [owner, name] = requiredEnvironment('GITHUB_REPOSITORY').split('/');
  const prNumber = Number(requiredEnvironment('PR_NUMBER'));
  const headSha = requiredEnvironment('HEAD_SHA');
  const requireCodexReview = process.env.REQUIRE_CODEX_REVIEW === 'true';
  if (!owner || !name || !Number.isInteger(prNumber) || prNumber <= 0) throw new Error('Invalid repository or PR number.');

  const [comments, unresolvedThreads] = await Promise.all([
    loadPullRequestComments(owner, name, prNumber),
    countUnresolvedReviewThreads(owner, name, prNumber),
  ]);

  const result = evaluateReviewGate({
    comments,
    headSha,
    requireCodexReview,
    unresolvedThreads,
  });

  if (result.failures.length) {
    console.error(result.failures.join('\n'));
    process.exitCode = 1;
    return;
  }

  const reviewState = result.latestCommitReviewed ? 'latest commit reviewed' : 'Codex review advisory only';
  console.log(`PR review gate passed: ${reviewState}; no unresolved review threads.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
