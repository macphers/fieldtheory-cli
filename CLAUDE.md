# CLAUDE.md

This is the Field Theory CLI: a local-first command-line companion for X bookmark sync, Field Theory Library workflows, portable commands, app install, and agent-facing context.

## Commands

```bash
npm run build        # Compile the server and build the React web bundle
npm run dev          # Run via tsx directly
npm run test         # Run tests
npm run check:docs   # Verify the Markdown inventory
npm run test:browser # Build and exercise the knowledge-page UI in Chromium
npm run verify       # Run docs, unit tests, production build, and browser tests
npm run start        # Run compiled dist/cli.js
```

See [`docs/harness.md`](docs/harness.md) for the full local and CI validation flow.

## Architecture

Commander.js drives the CLI. The private knowledge app adds a loopback-only HTTP API and React interface served from the same local process. Bookmark data is stored in `~/.fieldtheory/bookmarks/`; knowledge-page data is stored in `~/.fieldtheory/content/`; Library markdown is stored in `~/.fieldtheory/library/`; portable commands live under `~/.fieldtheory/commands/`; and Possible run artifacts live under `~/.fieldtheory/ideas/`.

### Key files

| File | Purpose |
|------|---------|
| `src/cli.ts` | Command definitions, progress bar, first-run UX |
| `src/paths.ts` | Data, library, and commands path resolution |
| `src/graphql-bookmarks.ts` | GraphQL sync engine (Chrome session cookies) |
| `src/bookmarks.ts` | OAuth API sync |
| `src/bookmarks-db.ts` | SQLite FTS5 index, search, list, stats |
| `src/bookmark-classify.ts` | Regex-based category classifier |
| `src/bookmark-classify-llm.ts` | Optional LLM classifier |
| `src/bookmarks-viz.ts` | ANSI terminal dashboard |
| `src/chrome-cookies.ts` | Chrome cookie extraction (macOS Keychain) |
| `src/xauth.ts` | OAuth 2.0 flow |
| `src/db.ts` | WASM SQLite layer (sql.js-fts5) |
| `src/library.ts` | Local Field Theory Library read/write helpers |
| `src/commands-files.ts` | Portable command file creation and validation |
| `src/app-open.ts` | Open Library pages in the packaged Mac app or a dev checkout |
| `src/app-install.ts` | Download and install packaged app releases |
| `src/skill.ts` | Install Field Theory agent skills for Claude Code and Codex |
| `src/ideas.ts` | Possible seeds, runs, jobs, and nightly schedules |
| `src/content/app.ts` | Local knowledge-app lifecycle, ingestion worker, and browser launch |
| `src/content/sqljs-repository.ts` | Durable knowledge items, jobs, transcripts, notes, and activity |
| `src/server/http.ts` | Loopback-only authenticated content API |
| `web/src/App.tsx` | Knowledge library, transcript, notes, chat, and job-state interface |

### Data flow

```
Chrome cookies → GraphQL API → JSONL cache → SQLite FTS5 index
                                    ↓
                           Regex classification
                                    ↓
                         Search / List / Viz
```

Field Theory app companion flow:

```text
~/.fieldtheory/library + ~/.fieldtheory/commands
                    ↓
              ft library / ft commands
                    ↓
    packaged Field Theory app or configured dev checkout
```

Private knowledge-page flow:

```text
X bookmark cache → YouTube discovery → captions or local transcription
                                      ↓
                         chapters + grounded synthesis
                                      ↓
                 local content database → loopback API → React UI
```

### Dependencies

All pure JavaScript/WASM — no native bindings:
- `commander` — CLI framework
- `sql.js` + `sql.js-fts5` — SQLite in WebAssembly
- `dotenv` — .env file loading
- `react` + `vite` — local knowledge-page interface and build

Knowledge-page ingestion can invoke optional user-installed `yt-dlp`, `ffmpeg`, and `whisper.cpp` executables.
