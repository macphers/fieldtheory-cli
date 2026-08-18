<!-- /autoplan restore point: /Users/mikemacpherson/.gstack/projects/afar1-fieldtheory-cli/feat-second-brain-upgrade-autoplan-restore-20260818-140902.md -->
# Field Theory second-brain upgrade plan

## Outcome

Turn Field Theory's local knowledge-page prototype into a dependable daily second brain. Saving a useful YouTube video, podcast, or article on X should make it appear automatically, become digestible quickly, remain searchable and chat-ready with citations, and connect to related ideas already in the library.

## Current evidence

- The local X cache contains 9,778 bookmarks, but only 24 unique knowledge sources are discovered: 23 YouTube videos and one podcast.
- Twenty-two sources have transcripts containing 39,954 searchable segments, but zero sources have promoted summaries and zero are chat-ready.
- Article enrichment has produced zero article pages even though 282 indexed bookmarks contain explicit links.
- The durable worker serializes expensive chapter generation ahead of summaries. Model timeouts can therefore prevent a source from becoming useful.
- Related-content discovery is an on-demand TF-IDF comparison. The product does not yet generate semantic embeddings, clusters, or a topic view.
- The running app was launched without sync. Bookmark sync is an explicit startup action, not a continuous freshness loop.

## Product promises

1. **Continuous inbox:** Incremental X bookmark sync runs at startup and on a bounded background cadence. New saves are prioritized ahead of historical repair work.
2. **Broad source coverage:** Direct and redirected YouTube URLs, X Articles, generic readable webpages, newsletters, direct podcast episode pages, Apple Podcasts, Spotify, and discoverable RSS episodes enter one normalized source pipeline. A manual URL entry is the reliable fallback.
3. **Fast usefulness:** A source becomes readable and searchable as soon as text is available. A concise cited overview is prioritized before optional chapter refinement. Independent work runs concurrently with bounded retries and visible recovery actions.
4. **Grounded understanding:** Summaries and chat cite transcript or article passages. Exact transcript search and semantic search coexist.
5. **Unified memory:** Sources, passages, highlights, notes, authored insights, topics, connections, projects, and idea seeds share one retrieval contract. Generated content never becomes a silo beside Field Theory Library Markdown or Possible.
6. **Connections:** Ready content and authored knowledge receive local semantic embeddings. Field Theory maintains explainable related-item scores, typed relationships, topic clusters, and a resurfacing feed that favors useful, non-obvious connections.
7. **Corpus understanding:** Mike can ask across the whole library, compare sources, find contradictions, trace how a topic changed, and promote a cited answer into durable Library knowledge or an idea seed.
8. **Daily-use interface:** Inbox, Ready, Processing, and Needs attention states make freshness and failures visible. A bounded daily briefing and weekly synthesis resurface prior memory without creating another inbox to clear.
9. **Agent-native recall:** The same retrieval service powers the browser, CLI, `ft ask`, and the Field Theory skill so relevant prior passages and authored notes can appear inside active Codex/Claude work.
10. **Local-first control:** Source text, transcripts, embeddings, topics, notes, activity, and model outputs remain local. External network access is explicit in diagnostics and documentation.

## Proposed architecture

```text
X incremental sync ─┐
Manual URL add ─────┼─> source candidates -> URL resolution -> normalized sources
Historical backfill ┘                                      |
                                                           v
                                            prioritized durable job graph
                                      ┌────────────┬────────────┬────────────┐
                                      v            v            v            v
                                  source text   quick cited   chapters    embedding
                                                summary
                                      └────────────┴────────────┴────────────┘
                                                           |
                                                           v
                                  local search + semantic index + topic clusters
                                                           |
                                                           v
                         Inbox / Library / Topics / Connections / Corpus Chat
                                      |                         |
                                      v                         v
                         durable Markdown / insights     agent retrieval / seeds
```

## Workstreams

### 0. Unified memory and retrieval

- Define stable domain entities for `Source`, `Passage`, `Highlight`, `Note`, `Insight`, `Topic`, `Connection`, and `ProjectRef`, with one authoritative store for each and stable IDs across SQLite and Library Markdown.
- Add a single retrieval contract that merges bookmark metadata, content passages, generated summaries, authored notes, Library Markdown, and idea seeds without duplicating ranking logic.
- Make authored highlights, notes, and insights first-class semantic nodes and weight them above generated summaries during recall.
- Support explicit, explainable relationships: `supports`, `contradicts`, `extends`, `example-of`, `derived-from`, and `relevant-to-project`.
- Add promotion paths from passage to highlight/note, note to durable insight, and insight to Library concept, project reference, or Possible seed.
- Extend `ft ask` and the installed Field Theory skill to use the unified retrieval layer while preserving current bookmark and Library behavior.

### 1. Freshness and ingestion

- Add a safe recurring incremental-sync loop to the app with backoff, cancellation, last-sync state, and manual refresh.
- Separate recent-source discovery from historical gap repair. Prioritize newest candidates and expose article-focused backfill.
- Resolve safe HTTP redirects and unwrap X link cards before source classification.
- Generalize article extraction and podcast episode/feed resolution without weakening SSRF and size/time limits.
- Add authenticated manual URL ingestion through the loopback API and UI.
- Record per-source discovery outcomes so unsupported links are visible rather than silently ignored.

### 2. Processing graph and recovery

- Replace the serial transcript-to-chapters-to-summary chain with explicit dependencies: source text unlocks summary, chapters, and embedding independently.
- Prioritize summaries and recent saves. Add bounded worker concurrency by resource class so model, network, and local CPU work do not block each other.
- Recover expired running jobs at startup, make retries idempotent, and provide simpler deterministic chapter fallback after repeated model timeouts.
- Let pages become usable progressively. Transcript/article text and promoted summary define chat readiness; chapters and embeddings enrich later.

### 3. Semantic memory and clustering

- Add a versioned embedding-provider interface with a local default and deterministic test provider.
- Store normalized vectors and embedding provenance in the content database.
- Embed a compact document representation plus bounded chunks; never embed an entire transcript as one unbounded request.
- Implement hybrid keyword/vector search and explainable related-item ranking.
- Cluster ready items incrementally, label clusters from representative terms/items, and persist membership with versioned rebuild support.
- Build a resurfacing policy combining similarity, novelty, recency, authored notes, active projects, saves, and prior opens without becoming an opaque recommendation feed.
- Maintain a small real evaluation corpus with expected topics, useful cross-topic links, contradictions, and false friends. Measure precision at small `k`, cluster coherence, label clarity, and explanation quality.
- Capture local feedback (`useful`, `obvious`, `wrong`, `dismiss`) and use it to improve future resurfacing without deleting provenance.

### 4. Daily-use product

- Replace the undifferentiated library list with Inbox, Ready, Processing, and Needs attention views.
- Add source-type and topic filters, summary previews, sync status, processing counts, and manual Add URL.
- Add Topics and Connections views with understandable cluster labels and "why related" evidence.
- Add a bounded daily briefing, a weekly synthesis of changing themes, and lifecycle states: New, Skimmed, Kept, Dismissed, Applied, and Archived.
- Add corpus chat with topic, source-type, date, and selected-item scopes; support comparisons, contradictions, evolution over time, and links to active projects.
- Allow cited corpus answers and user-authored observations to become durable Library concepts or Possible seeds through explicit confirmation.
- Preserve the quiet reading page while making partial, retry, and unavailable states concrete.
- Keep keyboard, screen-reader, mobile, touch-target, focus, overflow, and reduced-motion coverage in Playwright.

### 5. Verification and migration

- Add schema migrations that preserve the existing 22 transcripts and all notes/activity.
- Add fixture-backed ingestion tests for direct, redirected, unsupported, malicious, duplicate, and changed sources.
- Add worker dependency, priority, concurrency, restart, timeout, cancellation, and idempotency tests.
- Add embedding determinism, vector migration, hybrid ranking, clustering, and resurfacing tests.
- Add browser scenarios for the daily inbox, manual URL ingestion, semantic search, topics, connections, partial readiness, and recovery.
- Add a private local acceptance command that verifies one video, podcast, and article through the full loop without publishing user data.

## Acceptance criteria

- A newly bookmarked supported source is visible within five minutes while the app is running.
- A captioned video or readable article becomes summarized and chat-ready without waiting for chapters.
- Existing transcripts survive migration and are immediately keyword-searchable.
- The app exposes discovery results for every explicit saved link: supported, duplicate, unsupported, deferred, or failed.
- Semantic search returns conceptually related items that share no required exact token, while exact transcript search retains timestamp deep links.
- Every ready item has an embedding or an actionable explanation; clusters can be rebuilt deterministically.
- The Topics view groups a fixture corpus into stable, understandable themes and explains membership.
- The Connections view surfaces useful cross-topic relationships and explains the shared concepts.
- `ft ask`, the browser, and the Field Theory skill can retrieve the same cited passage or authored insight through the unified retrieval contract.
- A corpus question spanning multiple items returns a cited synthesis and can be promoted into durable Library knowledge.
- A seven-day private habit trial records at least one prior memory opened, kept, cited, or applied after Field Theory resurfaced it.
- Daily and weekly resurfacing remain bounded; historical backfill never creates an obligation to clear thousands of items.
- Every surfaced connection can be explained and marked useful, obvious, wrong, or dismissed.
- The full docs, unit, production build, and responsive browser suites pass.
- A real local smoke test prepares one video, one podcast, and one article and verifies summary, cited chat, keyword search, semantic search, and cluster membership.

## Not in the first upgrade

- Hosted multi-user accounts or cloud synchronization.
- Publishing or sharing private library contents.
- Native mobile applications.
- Automated actions outside the private knowledge workflow.

## North-star outcome

**Useful memory assists per active week:** a prior passage, authored note, insight, or connection surfaced by Field Theory that Mike opens, keeps, cites, promotes, or applies to current work.

The upgrade is successful when Field Theory brings the right prior idea into the current task without Mike hunting for it. Processing volume, embedding coverage, and cluster counts are health metrics, not the product outcome.

## Autoplan Phase 1: CEO review

### Premise challenge

| Premise | Verdict | Consequence |
|---|---|---|
| X bookmarks remain a high-signal capture gesture | Valid but fragile | Keep X as one `CaptureAdapter`; manual URL and local re-import are first-class fallbacks. |
| More processed sources produce a second brain | Rejected | Measure useful memory assists, not page count. Add triage, resurfacing, application, and feedback loops. |
| Source documents are the atomic unit of memory | Incomplete | Authored highlights, notes, insights, projects, and relationships must be first-class nodes. |
| A browser library is the primary value surface | Rejected as exclusive | The browser is the reading surface; unified retrieval must also reach CLI, agents, Library Markdown, and Possible. |
| Clusters automatically create useful connections | Unproven | Evaluate against a real gold corpus, explain every relation, and collect explicit feedback. |
| Eager historical processing is worthwhile | Rejected | Cheaply index history, process recent/important/queried sources first, and keep backfill outside the daily inbox. |
| Local embeddings are operationally straightforward | Unproven | Specify provider, hardware envelope, installation, versioning, cancellation, rebuild, and keyword-only degradation. |

Premise gate: confirmed by Mike's explicit instruction that Field Theory exists to help build a second brain and should surface content and interesting connections. The plan now defines that outcome as useful prior memory entering active work, not generic read-later parity.

### What already exists

| Need | Existing leverage | Plan use |
|---|---|---|
| Capture and provenance | GraphQL/OAuth bookmark sync, JSONL cache, bookmark SQLite index | Implement `CaptureCandidate` around existing paths; do not duplicate X ingestion. |
| Durable authored knowledge | `src/library.ts`, Library Markdown, navigation and wiki surfaces | Make Library documents authoritative for promoted insights and project knowledge. |
| Bookmark-grounded synthesis | `src/md-ask.ts`, `ft ask --save`, concept pages | Route through unified retrieval and retain save-to-concept behavior. |
| Agent access | `src/skill.ts` and installed Field Theory skill | Expose one retrieval command/API to Codex and Claude. |
| Idea development | `src/ideas-*`, seeds, theories, nightly jobs | Promote confirmed insights and connections into seeds without copying raw source records. |
| Source processing | `src/content/orchestrator.ts`, durable jobs, transcript providers, citations | Refactor the job graph and retain existing transcripts/artifacts. |
| Exact retrieval | bookmark FTS5 and transcript FTS5 | Keep keyword retrieval as a reliable peer and fallback to semantic retrieval. |
| Local security | loopback server, bootstrap session, CSRF and origin checks | Extend existing authenticated API for add, corpus query, feedback, and promotion. |

### Dream state delta

```text
CURRENT
  X save -> local cache -> 24 discovered -> serial preparation -> mostly unread pile
       + separate Library Markdown + separate Possible seeds + item-only chat

THIS PLAN
  capture adapters -> prioritized understanding -> unified memory graph/retrieval
      -> cited reading + corpus synthesis + explainable connections
      -> Library insights / project context / Possible seeds / agent recall
      -> bounded daily and weekly resurfacing -> explicit usefulness feedback

12-MONTH IDEAL
  Field Theory notices the active task, retrieves a few defensible prior memories,
  explains why they matter, and learns from Mike's keep/dismiss/apply decisions
  without requiring another inbox or surrendering local custody.
```

The upgrade reaches the complete personal loop for local capture, understanding, connection, resurfacing, and application. It deliberately stops short of hosted multi-user synchronization, autonomous publishing, and opaque behavioral personalization.

### Implementation alternatives

| Approach | Effort | Risk | Advantages | Costs | Decision |
|---|---:|---:|---|---|---|
| Expand only the current knowledge-page silo | Medium | High strategic risk | Reuses current code directly | Duplicates Library/ask/ideas memory and stops at read-later parity | Reject |
| Unified retrieval and memory model, then vertical source slices | Large | Medium | Builds one second brain and preserves current assets | Requires migrations and cross-surface contracts | Select |
| Outsource ingestion to a hosted reader and integrate later | Medium | High privacy/dependency risk | Fast broad format coverage | Weakens local-first wedge and project/agent integration | Defer as optional importer |

### Temporal interrogation

```text
HOUR 1:  migrate safely; existing transcripts and notes remain searchable
HOUR 2:  summarize the 22 prepared transcripts; corpus search becomes useful
HOUR 3:  unify authored Library notes and content passages under one retrieval API
HOUR 4:  add embeddings, explainable relations, corpus chat, and topic navigation
HOUR 5:  add bounded continuous sync, manual URL, and explicit discovery funnel
HOUR 6+: add observed high-volume resolvers, backfill on demand, run the habit trial
```

This is sequencing, not scope reduction. It validates the second-brain loop before extractor maintenance consumes the project.

### Error and rescue registry

| Error | Trigger | System response | User-visible rescue | Verification |
|---|---|---|---|---|
| `capture_auth_expired` | X credentials expire | Keep local library available; stop retry storm | Last success, failed attempt, reconnect action, manual add remains usable | Sync integration test |
| `source_unsupported` | Candidate cannot resolve to a supported source | Persist discovery outcome | Explain unsupported reason and retain original URL | Resolver fixtures |
| `source_fetch_denied` | Paywall, robots, auth, or region block | Preserve metadata; do not fabricate text | Open original and retry/manual paste options | Article error fixtures |
| `source_unsafe_url` | Private network, credentials, redirect abuse | Reject before fetch and record safe diagnostic | Explain that local/private targets are blocked | SSRF and redirect tests |
| `summary_timeout` | Model exceeds stage deadline | Promote transcript readiness; retry summary independently | Page remains searchable; retry shown | Job timeout test |
| `embedding_unavailable` | Local model missing or rebuild fails | Use keyword search and TF-IDF fallback | Diagnostic names model/install/rebuild action | Provider degradation test |
| `vector_version_stale` | Model or representation version changes | Queue background rebuild while old index remains readable | Reindex progress without search outage | Migration/rebuild test |
| `cluster_low_confidence` | Corpus too small or incoherent | Leave item unclustered; never force a label | "More evidence needed" | Gold-corpus evaluation |
| `connection_false_friend` | Vector similarity lacks cited conceptual support | Suppress below threshold | Feedback and explanation controls | Relation precision tests |
| `promotion_conflict` | Library document changed since suggestion | Preserve draft; require explicit merge | Show both versions and safe retry | Optimistic concurrency test |

### Failure modes registry

| Failure mode | Severity | Prevention and detection |
|---|---|---|
| A polished unread pile grows faster than it is used | Critical | Bounded inbox, cheap triage, lifecycle states, useful-assist metric, seven-day trial. |
| Content becomes a third silo beside Library and Possible | Critical | Unified retrieval and explicit authority/promotion rules are P1 prerequisites. |
| Generated summaries outweigh Mike's own thinking | High | Authored nodes rank higher; source/provenance labels are mandatory. |
| Corpus answers hallucinate across sources | High | Passage-level retrieval, cited source reasons, answer refusal, support validation. |
| Continuous sync creates retry storms or stale trust | High | Bounded cadence, exponential backoff, truthful sync status, degraded manual capture. |
| Clusters are obvious, unstable, or misleading | High | Versioned builds, small-k evaluation, unclustered state, feedback, cited explanations. |
| Local embedding model is too slow or too large | High | Named provider envelope, bounded batches, cancellation, keyword-only fallback. |
| Backfill monopolizes workers | High | Separate priority lanes; recent and user-requested work always wins. |
| Private content leaks through configured model tooling | High | Explicit provider boundary, local storage wording, redacted diagnostics, opt-in remote embeddings. |

### Scope decisions

Included: unified memory, corpus retrieval/chat, authored knowledge nodes, project and seed promotion, bounded resurfacing, usefulness feedback, continuous capture, broad source pipeline, semantic search, explainable clustering, and full migration/verification.

### NOT in scope

- Hosted accounts, collaboration, and cloud synchronization: they do not improve Mike's private second-brain loop and expand the security boundary.
- Native mobile applications and share extensions: manual URL and X capture cover the initial workflow; capture adapters leave a future seam.
- Autonomous writes into projects or published materials: Field Theory may propose and draft, but promotion remains explicit.
- A general web crawler: extraction remains bounded to user-saved URLs with strict safety limits.
- Opaque engagement optimization: ranking uses inspectable signals and explicit feedback, not a hidden attention-maximizing model.

### CEO independent voice

The required Codex CLI voice was unavailable because its packaged executable was missing. The independent subagent identified ten issues. Its two critical findings agreed with the primary review: technical throughput is not a second-brain outcome, and a new content database must not become another knowledge silo. It also required first-class authored knowledge, corpus chat, bounded triage, X-independent capture, real connection evaluation, explicit embedding operations, and an agent-native local-first wedge. No disagreement or unresolved user challenge remained after the plan was expanded.

### CEO consensus table

| Dimension | Independent subagent | Codex CLI | Consensus |
|---|---|---|---|
| Premises valid? | Needs rewrite | unavailable | Single voice, adopted |
| Right problem? | Reframe from reader to applied memory | unavailable | Single voice, adopted |
| Scope calibration? | Sequence full vertical slices | unavailable | Single voice, adopted |
| Alternatives explored? | Add unify-first, agent-first, on-demand enrichment | unavailable | Single voice, adopted |
| Competitive risk covered? | Local agent-native wedge required | unavailable | Single voice, adopted |
| Six-month trajectory? | Avoid silo and unread-pile outcome | unavailable | Single voice, adopted |

### CEO completion summary

| Area | Before | After review |
|---|---:|---:|
| Problem/outcome clarity | 6/10 | 10/10 |
| Existing-system leverage | 5/10 | 9/10 |
| Habit and application loop | 3/10 | 9/10 |
| Competitive wedge | 4/10 | 9/10 |
| Failure coverage | 6/10 | 9/10 |

Phase 1 status: complete. Premises confirmed through the user's explicit second-brain direction. Independent voice: 10 findings, Codex CLI unavailable, no unresolved disagreement.

<!-- AUTONOMOUS DECISION LOG -->
## Decision Audit Trail

| # | Phase | Decision | Classification | Principle | Rationale | Rejected |
|---|---|---|---|---|---|---|
| 1 | CEO | Reframe the outcome around useful memory assists | Mechanical | Completeness | A second brain must change recall and application, not merely process documents. | Artifact-count north star |
| 2 | CEO | Add a unified memory and retrieval contract | Mechanical | DRY | Existing Library, ask, content, ideas, and agent surfaces must not become separate silos. | Content-only index |
| 3 | CEO | Make authored knowledge first-class and higher weighted | Mechanical | Completeness | Mike's observations are more durable and intentional than automatic summaries. | Source-only graph |
| 4 | CEO | Add corpus synthesis and agent retrieval | Mechanical | Completeness | The highest-value recall happens across sources and inside active work. | Item-only chat |
| 5 | CEO | Bound the inbox and prioritize recent/explicit work | Mechanical | Pragmatic | Continuous ingestion must not increase attention debt or block on history. | Eager full backfill |
| 6 | CEO | Keep X as one capture adapter | Mechanical | Explicit | Honest degraded operation requires a stable non-X input contract. | X-coupled product identity |
| 7 | CEO | Evaluate connections on a real gold corpus with feedback | Mechanical | Completeness | Vector similarity alone cannot establish useful or defensible connections. | Cluster-count success metric |
| 8 | CEO | Sequence complete vertical slices without cutting final scope | Mechanical | Bias toward action | Existing transcripts can prove the second-brain loop before broad resolver work. | Extractor-first delivery |
| 9 | Design | Use Today, Library, Topics, Connections, and Ask as destinations | Mechanical | Explicit | Lifecycle and processing labels remain item state/filter metadata rather than competing navigation. | One destination per state |
| 10 | Design | Bound Today to three explainable memories | Mechanical | Completeness | The home surface must create recognition without becoming another feed or obligation. | Infinite briefing feed |
| 11 | Design | Gate capabilities independently by available artifact | Mechanical | Explicit | Text, search, notes, chat, summary, semantic recall, and clusters become useful at different stages. | One global Ready gate |
| 12 | Design | Use editorial topic and connection lists | Taste | Explicit | Text-first evidence matches the calm reader and stays accessible on mobile. | Force-directed graph |
| 13 | Design | Reduce visible lifecycle actions to Keep, Dismiss, and Applied | Taste | Pragmatic | New/Seen can be derived and Archive can remain a filter, avoiding filing work. | Six manual lifecycle states |
| 14 | Design | Make authored memory a passage-attached workflow | Mechanical | Completeness | A second brain must distinguish Mike's observation from generated prose and preserve evidence. | One freeform item note only |
| 15 | Eng | Keep sql.js only behind batched checkpoints and performance gates | Taste | Pragmatic | The current file is directly compatible and avoids a risky backend rewrite; full-export-per-write must be removed and native SQLite remains the measured fallback. | Immediate repository rewrite |
| 16 | Eng | Add fenced, atomic, prioritized DAG jobs | Mechanical | Explicit | A stale worker must never promote output, and recent/manual work must outrank backfill. | FIFO stage chaining |
| 17 | Eng | Project authoritative stores into a rebuildable memory index | Mechanical | DRY | Library, bookmarks, content, and ideas retain ownership while every surface shares ranking. | Cross-store mega-query or duplicated indexes |
| 18 | Eng | Version embeddings and clusters as immutable generations | Mechanical | Completeness | Shadow builds and atomic promotion prevent mixed dimensions, stale vectors, and topic churn. | In-place vector/cluster mutation |
| 19 | Eng | Derive capabilities from promoted artifacts | Mechanical | Explicit | Optional failures cannot make readable text or exact search disappear. | Latest-job global status |
| 20 | Eng | Ship reversible vertical releases behind feature flags | Mechanical | Bias toward action | Each data and product layer can be verified and rolled back without deleting authored knowledge. | One irreversible launch |
| 21 | DX | Introduce `ft memory` as the stable namespace | Taste | Explicit | It makes second-brain operations guessable while preserving `ft app` and `ft ask` aliases. | Overloading unrelated top-level commands |
| 22 | DX | Make doctor capability-based rather than globally usable/unusable | Mechanical | Completeness | Existing memory, manual articles, X sync, transcription, synthesis, semantic search, and chat degrade independently. | X/yt-dlp global prerequisite |
| 23 | DX | Make first useful result require only `ft memory open` | Mechanical | Pragmatic | Existing content appears immediately and optional capabilities explain their own setup. | Mandatory gap backfill before launch |
| 24 | DX | Add inspectable migration, sync, embedding, config, and verify commands | Mechanical | Explicit | Operators need exact status, recovery, and escape hatches without reading source or environment variables. | Hidden background state |
| 25 | DX | Ship manual capture in the first release slice | Mechanical | Bias toward action | An X-independent end-to-end path validates the product immediately. | Delaying manual Add URL to release five |

## Autoplan Phase 2: design review

Initial completeness: 6.5/10. Target after specification: 9/10. The current warm, quiet reader remains the visual anchor; new surfaces extend its editorial language rather than introducing dashboard chrome.

### Information architecture

```text
DESKTOP RAIL                     MOBILE
Today                           top: current destination + search/add
Library                         bottom: Today | Library | Topics | Ask
Topics                          Connections lives in Today/Topics and More
Connections
Ask
────────────────
sync health + settings

Library filters (not destinations): Inbox | Ready | Processing | Needs attention
Item actions (not destinations): Keep | Dismiss | Applied
Derived state: New / Seen
Storage filter: Archived
```

Routes, active state, search scope, and filters persist in the URL. Desktop navigation uses labeled icons on focus/hover and accessible names; mobile never depends on the fixed 56px icon rail.

### Today anatomy

Today shows at most three memories and never accumulates overdue cards:

1. One newly ready source worth skimming.
2. One prior passage, note, or insight connected to recent activity or an active project.
3. One evolving topic, useful disagreement, or weekly synthesis when due.

Each memory answers `Why now`, shows its provenance and supporting passage, labels generated versus authored relationships, and offers `Open evidence`, `Keep`, `Dismiss`, and `Relevant to project`. A completed state says there is nothing else to clear. Dismissal has undo and influences future ranking without deleting the memory.

### Core wireframes

```text
TODAY
┌ rail ┐  Today                         synced 4m ago   + Add
│      │  Three useful memories, no backlog
│      │
│      │  PRIOR IDEA FOR THIS WEEK
│      │  [authored note or source title]
│      │  Why now: connected to [active topic/project]
│      │  “supporting passage...”
│      │  Open evidence   Keep   Dismiss   Relevant to project
│      │
│      │  NEWLY READY ...
│      │  EVOLVING TOPIC ...
└──────┘

LIBRARY
┌ rail ┐  Library                       search everything   + Add
│      │  Inbox  Ready  Processing  Needs attention
│      │  [type] [topic] [status]
│      │  title + compact cited summary + source + why saved
│      │  title + progress/capabilities + clear next action
└──────┘

TOPIC
┌ rail ┐  AI coding agents
│      │  Representative concepts · recent change · confidence
│      │  Your insights
│      │  Strongest sources
│      │  Connections and disagreements, each with evidence
└──────┘

CORPUS ASK
┌ rail ┐  Ask your memory
│      │  [Topic: all] [Date: any] [Sources: all] [Projects: current]
│      │  question...
│      │  Claim / comparison / contradiction groups
│      │  source title · passage preview · location · why retrieved
│      │  Save as insight -> provenance preview -> explicit confirm
└──────┘
```

### Capture-to-confidence funnel

```text
Added -> Resolving -> Recognized -> Preparing -> Useful
                   \-> Duplicate (open existing)
                   \-> Unsupported (retain URL + reason)
                   \-> Needs access (open original + retry/manual text)
```

Manual Add URL validates paste input, supports keyboard submit/cancel, returns a compact receipt, and links duplicate captures to the existing source. Sync health shows last success, current attempt, next retry, authentication state, and degraded manual capture without dominating the library.

### Progressive capability matrix

| Available artifact | Enabled experience | Unavailable explanation |
|---|---|---|
| Metadata | Open source, provenance, capture status | Text still preparing or unavailable |
| Partial text | Read available passages and exact search | Completeness is labeled |
| Complete text | Highlight, note, exact search, cited item chat | Summary/semantic features may still prepare |
| Promoted summary | Cited overview and compact library preview | No effect on text/chat availability |
| Embedding | Semantic search and related evidence | Keyword-only mode remains usable |
| Topic membership | Topics, connections, resurfacing | Low-confidence items remain unclustered |

No single `Ready` boolean disables the whole page. Capabilities are projected independently from current artifacts.

### Authored-memory loop

```text
select source passage
  -> Highlight
  -> add "Your observation"
  -> optional relationship (supports / contradicts / extends / example)
  -> Promote as insight
  -> choose Library concept / Project reference / Possible seed
  -> preview source + passage + authored text
  -> explicit confirmation
```

`Your note`, `Generated summary`, and `Source passage` use unmistakable labels. Document-level notes remain available, but do not substitute for passage-level authored memory.

### Source-agnostic evidence

- Video and podcast citations seek to a timestamp.
- Article citations scroll to and visibly focus a stable passage anchor.
- Library citations open the heading and line context.
- Corpus citations always show source title, location, preview, and why the source was retrieved.
- Comparisons and contradictions group claims and evidence side by side at desktop widths and sequentially with headings on mobile.

### Unified search hierarchy

Every result includes object type, provenance, match reason, excerpt, exact location when available, and a semantic explanation when relevant. `Best` blends reliable exact and semantic evidence; `Exact` preserves FTS and transcript deep links; type/topic/date/project filters remain plain-language scopes. Keyword-only degradation is visible but fully usable.

### Cross-surface state matrix

| Surface | Loading/partial | Empty/success | Error/degraded |
|---|---|---|---|
| Today | Stable skeletons; prior cards remain | Consumed means nothing to clear | Ranking unavailable falls back to recent kept/newly ready |
| Sync | Current attempt plus last success | Fresh and idle | Stale/auth-expired shows reconnect and manual Add URL |
| Add URL | Resolving receipt with cancel | Recognized/duplicate opens item | Unsupported, paywalled, unsafe, or needs access retains original URL and action |
| Library | Existing results remain during refresh | Helpful query/filter reset | Exact-only fallback, retry, or persisted prior results |
| Item | Each artifact appears independently | Complete text enables useful core | Failed optional stage never blanks readable content |
| Topics | Version/build progress | Honest "not enough evidence" | Prior topic version remains until rebuild promotes |
| Connections | Explanation skeleton | No defensible connections | Feedback failure preserves choice locally for retry |
| Corpus Ask | Retrieval and answer stages announced | Refusal when evidence is thin | Partial support labels omitted claims and retry scope |
| Promotion | Provenance preview | Confirmed destination link | Conflict preserves draft and shows both versions |

### Responsive and accessibility contract

- Test 320px, 375px, tablet, desktop, 200% zoom, safe-area insets, long topic names, and the onscreen keyboard.
- Navigation uses real links; actions use buttons; filters/scopes use named tablists or removable chips.
- Connection evidence is always text-first; no relationship exists only through position, color, or animation.
- Live regions announce only state transitions, not spinner ticks or every sync update.
- Corpus answers have semantic headings per claim/source group; feedback communicates selected state.
- Sticky composers never cover focused inputs, citation targets, or final content.
- Minimum touch targets are 44px for primary mobile actions.

### Design passes

| Pass | Before | After specification | Key resolution |
|---|---:|---:|---|
| Information architecture | 4/10 | 9/10 | Five destinations; states become filters/metadata. |
| Interaction-state coverage | 5/10 | 9/10 | Cross-surface partial/stale/degraded matrix. |
| Journey and emotional arc | 6/10 | 9/10 | Recognition and evidence lead; no clearing pressure. |
| AI-slop resistance | 7/10 | 9/10 | Editorial lists, bounded Today, authored/generated labels. |
| Design-system alignment | 8/10 | 9/10 | Preserve warm quiet reader and thin-divided lists. |
| Responsive/accessibility | 7/10 | 9/10 | Explicit mobile navigation and semantic contracts. |
| Unresolved design decisions | 5/10 | 9/10 | Lifecycle, citation, chat, capture, topic, and feedback interactions specified. |

### Design independent voice

The independent designer found 15 issues: two critical, ten high, and three medium. The primary review adopted the recommended information hierarchy, bounded Today, visible capture funnel, independent capability gates, authored-memory flow, source-agnostic citations, scoped corpus chat, editorial topic/connection lists, hybrid result contract, state matrix, simplified lifecycle, mobile navigation, semantics, and trust-first `Why now` moment. Codex CLI remained unavailable. The only taste choices were editorial lists over a node graph and three explicit lifecycle actions; both follow the established quiet-minimal product direction.

### Design completion summary

Phase 2 status: complete. Overall design plan moved from 6.5/10 to 9/10. No unresolved design decision remains; the implementation must preserve the current reader and build the recall/application loop around it.

## Autoplan Phase 3: engineering review

### Scope challenge and existing-code leverage

The change crosses the content repository, durable worker, bookmark sync, Library Markdown, `ft ask`, installed skill, server API, and React UI. Those are direct parts of one retrieval loop, not unrelated expansion. The implementation will preserve current authoritative stores and add a rebuildable projection rather than merge all data into one database.

The immediate bottleneck is not sql.js query execution; it is `SqlJsContentRepository.transaction()` exporting and syncing the entire database after every small write. The first implementation removes that behavior through dirty tracking, atomic batch transactions, bounded debounced checkpoints, explicit durable stage boundaries, and mandatory close/shutdown flush. A synthetic 100k-passage benchmark gates release. If p95 interactive reads exceed 150ms, worker lease writes exceed 100ms, startup exceeds two seconds, or checkpoints exceed 500ms, the same repository contract moves content storage to native SQLite/WAL before continuous concurrency is enabled.

### Architecture

```text
Capture adapters
  X sync | manual URL | local JSONL re-import
      |
      v
candidate/outcome ledger ---- safe resolver/extractors
      |                              |
      +------------------------------+
                     |
                     v
       desired-state reconciler + durable outbox
                     |
                     v
 prioritized fenced job DAG (network / model / CPU resource lanes)
     | text           | summary         | embedding         | chapters
     +----------------+-----------------+-------------------+
                     |
                     v
authoritative stores and immutable promoted artifacts
  bookmarks DB | content DB | Library Markdown | Possible stores
                     |
           normalized change checkpoints
                     v
            rebuildable MemoryIndex
  keyword FTS + semantic generations + relation evidence + topic snapshots
                     |
            UnifiedRetrievalService
       /            |          |          \
 browser API      ft ask      agent skill   resurfacing/corpus chat
```

Authority rules:

- Bookmark records own capture provenance and raw X state.
- Content records and content-addressed artifacts own normalized sources, passages, transcripts, and generated source summaries.
- Library Markdown owns promoted authored insights and project knowledge; stable memory IDs live in frontmatter, never paths.
- Possible owns seeds/theories and references memory IDs rather than copying source text.
- `MemoryIndex` is disposable. Tombstones and checkpoints ensure deletes/renames propagate, but the index is never authoritative.

### Immutable identity

- Every memory node receives a random immutable UUID.
- `source_aliases` records every observed URL, resolved URL, canonical URL, resolver version, and provenance.
- Passage IDs derive from source content hash, segmentation version, and stable location; updated text creates new passage versions.
- Library documents receive `field_theory_id` frontmatter and retain it through rename.
- Merge and split operations create explicit redirects/tombstones; IDs are never silently rewritten.
- Authored edges remain separate from generated relation snapshots and can never be overwritten by a rebuild.

### Fenced durable job graph

```text
candidate resolved
      -> metadata/text acquisition
             -> [summary, embedding, chapters] independent children
summary + embedding -> memory projection
embedding generation complete -> cluster snapshot candidate
cluster snapshot validated -> atomic promote -> resurfacing refresh
```

Each job stores `kind`, `item_id?`, `input_fingerprint`, `implementation_version`, `resource_class`, `priority`, `source_recency`, `available_at`, `supersession_key`, `attempt`, `lease_owner`, and monotonically increasing `fence_token`. Dependencies reference required promoted artifact fingerprints, not only predecessor job IDs.

Recent manual capture has highest priority, followed by recent X capture, explicit retry/open/query demand, stale useful items, and historical backfill. Aging prevents starvation. Workers may run network, model, and CPU tasks concurrently within separate limits; repository transactions remain short and serialized.

Every promotion and terminal transition requires the current fence token. Artifact promotion, outbox child creation, and parent success commit atomically. A startup reconciler compares current artifacts with desired DAG predicates and repairs missing child jobs or abandoned outputs. Slow workers finishing after expiry, cancellation, or supersession are rejected.

### Processing and capability rules

- Text completion atomically fans out summary, embedding, and chapters.
- Summary does not depend on generated chapters; it uses creator sections or deterministic bounded windows.
- Complete text enables exact search, highlighting, notes, and cited item chat immediately.
- `hasText`, `exactSearch`, `hasSummary`, `chatReady`, `semanticReady`, and `clustered` are derived independently from promoted current artifacts.
- Optional rebuild or chapter failures remain warnings and never downgrade readable content.
- Repeated chapter model timeout falls back to deterministic labeled windows.

### Semantic provider and vector generations

The supported local provider is `Xenova/all-MiniLM-L6-v2` through Transformers.js: 384-dimensional, mean-pooled, L2-normalized vectors, quantized local inference, bounded batches, and cancellation between batches. The model is explicitly installed through `ft app embeddings install`; it is never silently downloaded. Doctor reports approximate disk usage, cache path, provider/model/version, hardware support, and rebuild estimate. Keyword-only search remains available when the model is missing. Remote embeddings require a separate explicit opt-in and are not part of this upgrade.

Vectors are immutable rows keyed by `(memory_node_id, passage_id?, content_hash, provider, model, dimensions, representation_version, generation_id)`. A new generation builds in shadow tables, validates dimensions, hashes, coverage, normalization, and sample neighbors, then atomically becomes active. Old active vectors remain queryable until promotion and are retained for rollback.

The compact document representation contains title, creator, cited summary claims, authored notes, and bounded representative passages. Long transcripts also receive bounded passage embeddings; chunk count and total text are capped per source. The vector cache is loaded lazily and invalidated only when a generation promotes.

### Hybrid retrieval and corpus synthesis

Keyword and semantic candidates are retrieved independently, normalized, deduplicated by canonical memory/passage identity, diversity-limited per source, and fused with reciprocal-rank fusion. Authored nodes receive an explicit boost. Exact mode bypasses semantic fusion and preserves transcript deep links.

Corpus chat enforces maximum passages, sources, tokens, and per-source diversity. The model returns structured claim groups with per-claim passage citations. The existing support validator checks every claim against only its cited passages; unsupported claims are removed, partial support is labeled, and insufficient evidence refuses. Untrusted sources are delimited and prompt-injection tests are mandatory.

### Cluster and connection snapshots

- Cluster builds are immutable versioned snapshots over one validated embedding generation.
- Deterministic seeded spherical k-means supplies a simple baseline; low-confidence nodes remain unclustered.
- Topic IDs remain stable by matching new centroids and representatives to the prior snapshot above a threshold.
- Labels derive from representative terms and items and are validated for uniqueness and readability.
- Generated relations store score, typed relation candidate, shared concepts, supporting passage IDs, model/build version, and confidence.
- User-created topics, labels, and relationships live separately and always win presentation conflicts.
- The gold corpus gates small-k connection precision, false-friend suppression, cluster coherence, label clarity, and longitudinal topic stability.

### Safe URL resolution

The resolver accepts only HTTP(S), forbids credentials, caps redirects, bytes, and wall time, resolves both A and AAAA records, rejects private/reserved/loopback/link-local/multicast ranges on every hop, and pins the approved address for the request. Redirects are revalidated. Diagnostics redact query values and page bodies. Generic fetchers never hand an unchecked URL to a subprocess. Specialized external tools operate only after the source adapter has validated and canonicalized the public target.

### Durable capture scheduler

Sync runs are durable per-adapter jobs with single-flight keys, last attempt/success, remote cursor, bounded jittered backoff, authentication suspension, manual refresh coalescing, shutdown cancellation, and clock-jump-safe scheduling. Candidate import and cursor commit are atomic. Discovery consumes the committed candidate outbox. Restart-mid-page, duplicate pages, cursor regression, authentication expiry, and timer/manual races are tested.

### Migration and rollback

1. Stop workers and checkpoint the current database.
2. Create a timestamped owner-only backup and a separate migration target.
3. Apply ordered ledger migrations on the target.
4. Verify schema version, row counts, transcript content hashes, notes, activity, foreign keys, and artifact references.
5. Atomically swap only after verification; preserve the previous DB and artifacts for rollback.
6. On interruption, disk-full, permission, or validation failure, leave the source untouched and report an actionable error.

Sanitized fixtures cover every released schema plus interrupted pre-swap and disk-full simulations. Feature flags allow the old reader, keyword retrieval, and prior active semantic/cluster generation to remain usable during rollback. New authored data is never deleted by rollback.

### Performance plan

| Workload | Gate |
|---|---:|
| 100k passages, exact search | p95 < 150ms |
| 10k document vectors, semantic top-k | p95 < 250ms after warm cache |
| 10k-item startup | < 2s before UI is usable |
| Batched DB checkpoint | p95 < 500ms and never on each segment/vector row |
| Concurrent reader during three worker lanes | no UI read > 500ms; no lease loss |
| Full vector rebuild | bounded memory < 1GB; cancellable; old generation remains active |

If sql.js misses these gates, native SQLite/WAL becomes a release blocker rather than a future optimization.

### Test diagram

```text
capture
  direct / redirect / duplicate / unsupported / paywall / unsafe / auth-expired
    -> unit resolver + integration scheduler + browser receipt states
processing DAG
  fan-out / priority / aging / retry / cancel / supersede / crash / stale worker
    -> state-machine property tests + repository transaction tests + forced-process tests
migration
  each schema / interrupted copy / disk full / bad FK / hash mismatch / rollback
    -> fixture migration tests
memory projection
  add / update / delete / rename / tombstone / checkpoint resume / full rebuild
    -> projection contract tests
semantic generation
  install missing / wrong dimensions / stale hash / cancel / shadow promote / rollback
    -> provider + repository + benchmark tests
retrieval
  exact / semantic / hybrid / authored boost / diversity / false friend / degraded
    -> gold-corpus ranking tests
clusters and connections
  stable IDs / low confidence / authored override / feedback / rebuild
    -> deterministic snapshot and longitudinal tests
corpus chat
  multi-source / contradiction / duplicate / injection / unsupported claim / refusal
    -> prompt/eval + citation validation tests
UI
  Today / Library filters / add receipt / progressive item / Topics / Connections /
  corpus Ask / highlight-promotion / mobile / keyboard / screen reader / stale states
    -> Playwright production-build matrix
```

Required invariants:

- Exactly one promoted artifact per current content/version.
- No stale, expired, cancelled, or superseded worker can promote output.
- No live relation references a missing node/passage.
- No migration, rebuild, or rollback loses authored data.
- Keyword search remains available through every optional-provider failure.
- Historical work cannot starve recent/manual work.

### Failure modes registry

| Failure | Critical gap? | Resolution |
|---|---|---|
| Full DB export blocks UI and lease renewal | Yes | Batched checkpoints plus performance gate; native WAL fallback before concurrency. |
| Stale worker publishes after lease expiry | Yes | Fencing tokens on every promotion/transition. |
| Crash stores artifact without downstream work | Yes | Atomic outbox plus desired-state reconciliation. |
| Migration partially rewrites the only DB | Yes | Copy, verify, atomic swap, retained backup. |
| URL resolves publicly then rebinds privately | Yes | DNS/IP validation and pinned dispatcher per hop. |
| Mixed vector dimensions enter active search | Yes | Immutable shadow generation validation and atomic promotion. |
| Generated clusters overwrite authored organization | Yes | Separate authorities; authored labels/edges win. |
| Optional stage failure makes source unreadable | Yes | Artifact-derived independent capability projection. |

### Rollout order

1. Migration ledger, identities, projection contract, and read-only unified keyword retrieval.
2. Fenced DAG, batched persistence, independent capabilities, and summaries for existing transcripts.
3. Explicit local embedding install, vector generations, and hybrid retrieval.
4. Topic snapshots, explainable connections, feedback, and corpus chat.
5. Durable continuous capture, manual URL, safe resolver, and discovery funnel.
6. Today/resurfacing, authored promotion, agent/`ft ask` integration, and private habit trial.

Each release is vertical, feature-flagged, measured against the local copied corpus, and backward-readable. This ordering is a rollback boundary, not a reduction of final scope.

### Eng independent voice and consensus

The independent engineer found 15 issues, including four critical prerequisites: persistence performance, a real prioritized DAG, fenced writes, and reversible migration. The primary review adopted the DAG, fencing, migration, identity, projection, embedding-generation, cluster-snapshot, corpus-validation, URL-safety, scheduler, capability, rollout, and race/performance requirements. It did not immediately replace sql.js; instead, it removed full-export-per-write behavior and made synthetic corpus gates decide whether native SQLite/WAL is required. That is the one valid taste disagreement and is explicitly release-gated.

| Dimension | Independent subagent | Codex CLI | Consensus |
|---|---|---|---|
| Architecture sound? | Requires DAG/projection/identity prerequisites | unavailable | Adopted |
| Test coverage sufficient? | Race, property, performance gaps | unavailable | Adopted |
| Performance addressed? | Backend risk critical | unavailable | Gated taste decision |
| Security covered? | DNS rebinding/subprocess gaps | unavailable | Adopted |
| Error paths handled? | Atomicity/reconciliation gaps | unavailable | Adopted |
| Deployment manageable? | Vertical reversible rollout required | unavailable | Adopted |

### Engineering completion summary

| Area | Before | After review |
|---|---:|---:|
| Architecture and authority | 6/10 | 9/10 |
| Data safety and migration | 4/10 | 10/10 |
| Concurrency correctness | 3/10 | 10/10 |
| Performance specificity | 4/10 | 9/10 |
| Security and error paths | 6/10 | 9/10 |
| Test completeness | 6/10 | 10/10 |

Phase 3 status: complete. The implementation has explicit storage gates, fenced atomic work, reversible data changes, and invariant-driven verification. No unresolved engineering decision remains.

## Autoplan Phase 3.5: developer-experience review

Product type: local-first CLI plus private web application and agent integration. Primary persona: Mike as a technical power user who wants useful memory without operating a data pipeline. Initial time to first useful result is 10–60+ minutes because the documented path requires tool installation and a historical gap pass; target is under two minutes for existing memory and under five minutes for a newly supported captioned/readable source.

### Developer journey map

| Stage | Current friction | Upgraded experience | Target |
|---|---|---|---:|
| Discover | README leads with bookmark CLI | Lead with private second-brain outcome and source support | <1 min |
| Install | npm plus optional tools unclear by capability | `npm install -g fieldtheory`; optional capability table | <2 min |
| First run | `sync --gaps` blocks perceived success | `ft memory open` migrates safely and opens existing memory immediately | <2 min |
| First capture | Depends on X sync | `ft memory add <url>` plus browser Add URL receipt | <1 min |
| First understanding | Serial chapter work blocks summary | Text/search/chat, summary, embedding, chapters appear independently | <5 min supported source |
| First connection | Hidden TF-IDF button | Explainable semantic neighbor and topic appear when ready | <10 min local embedding |
| Daily operation | No continuous status/control | Bounded Today plus truthful sync/provider health | seconds |
| Debug/recover | Doctor and thrown errors vary | One error contract plus exact recovery commands and backups | <2 min diagnosis |
| Extend/agent use | Skill searches silos separately | Browser, CLI, `ft ask`, and installed skill share retrieval | one command/query |

### Developer empathy narrative

I should be able to run one obvious command and see the memory I already own. Missing X authentication must not hide existing transcripts or Library notes. If semantic search is unavailable, exact search should still work and tell me the single command that enables embeddings. If a migration or worker fails, I should see what happened, what remains safe, and the exact inspect/restore/retry command. I should never need to infer which database, cache, model, or environment variable is active.

### Stable command surface

```text
ft memory open                         # open immediately; safe migration + background work
ft memory add <url>                    # universal capture path
ft memory search <query> [--exact]     # unified retrieval
ft memory ask <question> [scopes]      # cited corpus synthesis
ft memory topics                       # topics and connections summary
ft memory doctor [--json]              # independent capability report
ft memory sync status|now|pause|resume # durable capture control
ft memory backfill status|pause|resume # historical work never blocks recent work
ft memory embeddings install|status|rebuild|cancel|uninstall
ft memory migrate --check|--dry-run
ft memory backups list
ft memory restore <backup>
ft memory config show --effective --json
ft memory verify [--fixtures | --video ... --podcast ... --article ...]
ft memory report [--json]
ft memory activity export|reset
```

`ft app` remains a compatibility alias for `ft memory open`. Existing `ft ask` becomes a compatibility alias for unified corpus ask while retaining current `--save` behavior and a documented `--legacy-bookmarks` escape hatch for one release cycle.

### Capability-based doctor

Doctor reports each capability independently: `existing-memory`, `manual-article`, `x-sync`, `video-captions`, `podcast-feed`, `local-transcription`, `synthesis`, `semantic-search`, `corpus-chat`, `library-projection`, and `loopback-security`. Each row includes state, detected version/path, why unavailable, exact fix, and what remains usable. Exit status fails only when a specifically requested capability is unavailable; general doctor output may be degraded but usable.

### Error contract

Every CLI JSON response, API error, persisted job failure, and UI recovery state uses:

```json
{"code":"embedding_model_missing","message":"Semantic search is unavailable because the local model is not installed.","action":"Run `ft memory embeddings install`; exact search remains available.","retryable":false,"diagnosticId":"local-redacted-id"}
```

Human output leads with the same problem/cause/fix. Diagnostics redact credentials, URL query values, source bodies, and model prompts. Copy-paste recovery commands are black-box tested.

### Migration and backup operations

- `migrate --check` validates source schema, permissions, free disk, artifacts, and backup location without writing.
- `migrate --dry-run` copies and fully validates a candidate without swapping it.
- `backups list` reports schema, created time, size, validation, and retention.
- `restore` verifies the target, stops workers, preserves the current database as another backup, and requires explicit confirmation before swapping.
- Documentation states backup permissions, retention, disk needs, interruption behavior, and authored-data guarantees.

### Embedding operator contract

Install output states the model name, revision, license link, expected download/cache size, local cache owner/path, proxy/offline behavior, resume behavior, checksum verification, and the text that will be processed locally. Status reports dimensions, representation version, active generation, coverage, disk use, and rebuild estimate. Cancel preserves the old active generation; uninstall requires confirmation and leaves keyword search available.

### Escape hatches

- `--exact` and keyword-only operation
- `--manual-only` and background sync pause
- `--no-model-work` for transcript/article-only use
- per-job cancel/retry and backfill pause
- memory projection/vector/cluster rebuild from authoritative stores
- old-reader feature flag during rollout
- authored-note/activity export before repair or reset
- effective configuration report with redacted provenance

### Local outcome measurement

`memory_assist` events remain local and record memory ID, surfaced reason, surface, action (`opened`, `kept`, `cited`, `promoted`, `applied`), and bounded attribution window. `ft memory report` shows weekly useful assists, source-to-insight promotion, dismissed/wrong connections, sync freshness, and processing health. `activity export/reset` provides explicit ownership. No product telemetry leaves the machine.

### DX scorecard

| Dimension | Initial | Target | Plan change |
|---|---:|---:|---|
| Getting started | 4/10 | 9/10 | One-command open, existing memory first, manual capture immediately. |
| CLI/API design | 5/10 | 9/10 | Stable `ft memory` namespace and compatibility aliases. |
| Errors/debugging | 6/10 | 9/10 | Shared error contract, diagnostic ID, exact recovery command. |
| Documentation | 6/10 | 9/10 | Five-minute start, support matrix, privacy boundary, upgrade/recovery recipes. |
| Upgrade/migration | 5/10 | 10/10 | Check, dry-run, backups, restore, retained authored data. |
| Environment/tooling | 6/10 | 9/10 | Capability doctor and effective config provenance. |
| Ecosystem/agents | 4/10 | 9/10 | Unified installed skill, browser/CLI parity, integration test. |
| Measurement/feedback | 3/10 | 9/10 | Local useful-assist events and report/export/reset. |

Overall: 4.9/10 to 9.1/10. TTHW: 10–60+ minutes to under two minutes for existing memory and under five minutes for a new supported source.

### DX implementation checklist

- [ ] Add the `ft memory` command group and compatibility aliases.
- [ ] Make `open` useful before optional sync/model/embedding setup completes.
- [ ] Replace global doctor usability with independent capabilities.
- [ ] Standardize the error contract and test copy-paste recovery.
- [ ] Add migration check/dry-run, backup listing, and restore.
- [ ] Add embedding install/status/rebuild/cancel/uninstall.
- [ ] Add sync and backfill status/pause/resume/now controls.
- [ ] Name and implement fixture/real-local `memory verify`.
- [ ] Update README, architecture, privacy/model boundary, support matrix, and troubleshooting.
- [ ] Update and integration-test the installed Field Theory skill.
- [ ] Add effective config provenance and all escape hatches.
- [ ] Add local assist measurement, report, export, and reset.

### DX independent voice and consensus

The independent DX reviewer found two critical, seven high, and six medium issues. The primary review adopted unified skill access, independent doctor capabilities, immediate existing-memory onboarding, a stable namespace, common errors, operational migration/backups, full embedding controls, durable sync controls, a named verification command, documentation, escape hatches, local measurement, first-slice manual capture, black-box recovery tests, and effective configuration provenance. Codex CLI remained unavailable. No unresolved disagreement remains.

Phase 3.5 status: complete. The plan now specifies a sub-five-minute first useful result, operator-safe recovery, agent parity, and a measurable daily loop.

## Cross-phase themes

- **One memory system, not another reader:** CEO, design, engineering, and DX independently required integration across content, Library Markdown, `ft ask`, Possible, browser, and agents.
- **Useful before complete:** every phase rejected serial/global readiness and historical backlog as prerequisites for value.
- **Trust through evidence and recoverability:** cited explanations, authored/generated distinction, fencing, backups, degraded operation, and exact recovery commands recur across phases.
- **Bounded attention:** Today, processing priority, feedback, and outcome metrics must reduce attention debt rather than create it.
- **X is an adapter, not the product:** manual capture, durable scheduler state, and truthful degraded mode are required from the first release.

## Implementation tasks

1. Harden persistence and processing with batched checkpoints, fenced attempts, explicit priority/dependencies, atomic artifact promotion, desired-state reconciliation, and artifact-derived capabilities.
2. Project bookmarks, content artifacts, and Library Markdown into one rebuildable memory index with immutable identities, provenance, aliases, and tombstones.
3. Add immediate manual URL capture and durable X sync controls, then resolve video, podcast, article, and feed sources behind a safe resolver boundary.
4. Summarize existing transcripts, add exact and hybrid retrieval, installable local embeddings, immutable topic snapshots, explainable connections, and cited corpus synthesis.
5. Make highlights, observations, insights, lifecycle actions, and promotion into durable Markdown first-class authored memory.
6. Ship the calm Today, Library, Topics, Connections, and Ask interface with progressive capability states and accessible responsive behavior.
7. Add the stable `ft memory` CLI, truthful capability doctor, sync/backfill/embedding controls, migration and recovery tools, reporting, verification, compatibility aliases, docs, and agent-skill parity.
8. Verify migration safety, crash and lease races, retrieval quality, prompt/URL security, large-corpus performance, browser behavior, accessibility, and the full local workflow before shipping.

## GSTACK REVIEW REPORT

| Run | Voice | Status | Findings incorporated | Unresolved |
|---|---|---|---:|---:|
| CEO review | Primary + independent subagent | Complete | 10 | 0 |
| Design review | Primary + independent subagent | Complete | 18 | 0 |
| Engineering review | Primary + independent subagent | Complete | 15 | 0 |
| Developer-experience review | Primary + independent subagent | Complete | 12 | 0 |

VERDICT: APPROVED FOR IMPLEMENTATION. The four review voices converge on one local, agent-native memory system that is useful before optional enrichment completes, preserves authored data, explains its evidence, and degrades safely.

NO UNRESOLVED DECISIONS
