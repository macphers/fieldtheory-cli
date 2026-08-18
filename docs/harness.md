# Engineering harness

The harness turns failures discovered during development into checks that prevent recurrence.

## Local checks

```bash
npm run check:docs
npm test
npm run build
npm run test:browser
npm run verify
```

`check:docs` requires every project-owned Markdown file to be listed in [`docs/inventory.md`](inventory.md) with a purpose, status, and freshness requirement.

`test:browser` builds the production web bundle and exercises 16 browser scenarios across representative desktop and mobile viewports in Chromium. It uses a dedicated strict preview port and never reuses an unrelated local server. It checks core rendering, horizontal overflow, mobile touch-target sizing and crowding, keyboard reachability, visible focus, source-tab semantics, note-conflict recovery, library/transcript search, deliberately revealed related-item discovery, YouTube and enriched X article reading pages, and the library, transcript, notes, chat, processing, and blocked-state interactions. API responses are deterministic fixtures; HTTP security remains covered separately by server contract tests. CI downloads the pinned Playwright Chromium build without rerunning the runner's OS package installer, and bounds that download to five minutes.

`verify` is the single pre-push gate. It checks the documentation inventory, runs the full unit suite, builds the production server and web app, then runs the already-built browser suite.

## Codex PR review

`.github/workflows/codex-review.yml` reviews the latest PR commit for trusted repository authors with the official `openai/codex-action`. It posts a marker containing the reviewed head SHA and then verifies that no review thread remains unresolved.

Repository setup:

1. Add `OPENAI_API_KEY` as a GitHub Actions secret.
2. Optionally set the `CODEX_MODEL` Actions variable; the workflow defaults to `gpt-5.5`.
3. Observe the workflow in advisory mode until its findings are consistently useful.
4. Add `Codex review / review-gate` to the protected branch’s required status checks when ready to enforce it.

When the secret is absent, the workflow reports an advisory skip instead of failing every contribution. It never exposes the secret to untrusted PR authors: only owners, members, and collaborators can invoke the Codex step, the checkout does not persist credentials, and Codex runs with a workspace permission profile.
