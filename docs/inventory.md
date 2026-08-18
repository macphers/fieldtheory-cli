# Documentation inventory

Every project-owned Markdown file must appear here. CI verifies path coverage and required metadata. Update the corresponding row whenever a document’s role, lifecycle, or review cadence changes.

| Path | Purpose | Status | Freshness requirement |
|---|---|---|---|
| `.claude/commands/fieldtheory.md` | Agent command instructions for Field Theory workflows. | Active | Review when CLI commands or document-edit protocols change. |
| `.github/PULL_REQUEST_TEMPLATE.md` | Required author checklist and PR context. | Active | Review when CI, testing, or contribution gates change. |
| `CLAUDE.md` | Repository-level agent guidance. | Active | Review with agent workflow or architecture changes. |
| `CONTRIBUTING.md` | Contributor setup, validation, and submission guidance. | Active | Review when tooling, CI, or contribution policy changes. |
| `README.md` | User-facing installation, commands, architecture, and security overview. | Active | Review for every user-visible release. |
| `SECURITY.md` | Vulnerability reporting and security expectations. | Active | Review annually and after security-boundary changes. |
| `docs/harness.md` | CI harness architecture, local commands, and GitHub setup. | Active | Review whenever a harness check or required secret changes. |
| `docs/inventory.md` | Canonical inventory of project-owned Markdown. | Active | Update in the same commit as any Markdown add, move, or removal. |
| `docs/second-brain-upgrade-plan.md` | Reviewed implementation plan for continuous ingestion, semantic memory, clustering, and daily-use knowledge workflows. | Active | Review throughout the second-brain upgrade and archive after release. |
