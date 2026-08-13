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

async function main() {
  const [owner, name] = requiredEnvironment('GITHUB_REPOSITORY').split('/');
  const prNumber = Number(requiredEnvironment('PR_NUMBER'));
  const headSha = requiredEnvironment('HEAD_SHA');
  const requireCodexReview = process.env.REQUIRE_CODEX_REVIEW === 'true';
  if (!owner || !name || !Number.isInteger(prNumber) || prNumber <= 0) throw new Error('Invalid repository or PR number.');

  const data = await githubGraphql(`
    query ReviewGate($owner: String!, $name: String!, $number: Int!) {
      repository(owner: $owner, name: $name) {
        pullRequest(number: $number) {
          comments(last: 100) { nodes { body } }
          reviewThreads(first: 100) {
            nodes { isResolved }
            pageInfo { hasNextPage }
          }
        }
      }
    }
  `, { owner, name, number: prNumber });

  const pullRequest = data.repository?.pullRequest;
  if (!pullRequest) throw new Error(`Pull request #${prNumber} was not found.`);
  if (pullRequest.reviewThreads.pageInfo.hasNextPage) {
    throw new Error('The PR has more than 100 review threads; inspect them manually before merging.');
  }

  const result = evaluateReviewGate({
    comments: pullRequest.comments.nodes.map((comment) => comment.body),
    headSha,
    requireCodexReview,
    unresolvedThreads: pullRequest.reviewThreads.nodes.filter((thread) => !thread.isResolved).length,
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
