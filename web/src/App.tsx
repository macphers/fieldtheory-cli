import React, { useEffect, useRef, useState } from 'react';
import { ApiError, addCapture, allowLongTranscription, askCorpus, askItem, cancelJob, getConnections, getItem, getRelatedItems, getSyncHealth, getToday, getTopics, getTranscript, listItems, recordActivity, recordMemoryFeedback, retryJob, saveNote, searchContent } from './api';
import type { CaptureReceipt, ChatAnswer, ContentSearchHit, CorpusAnswer, KnowledgeItem, MemoryConnection, MemoryTopic, RelatedContentHit, SyncHealth, TodayMemory, TranscriptSegment } from './types';

export function formatTimestamp(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function youtubeEmbedUrl(videoId: string, origin?: string): string {
  const params = new URLSearchParams({ enablejsapi: '1', rel: '0' });
  if (origin) params.set('origin', origin);
  return `https://www.youtube-nocookie.com/embed/${encodeURIComponent(videoId)}?${params.toString()}`;
}

function sourceLabel(item: KnowledgeItem): string {
  try { return new URL(item.canonicalUrl).hostname.replace(/^www\./, ''); } catch { return item.type; }
}

function statusMessage(item: KnowledgeItem): string {
  if (item.status === 'ready') return item.language && item.language !== 'en' ? `Ready · Source transcript in ${item.language.toUpperCase()} · synthesis in English` : 'Ready · grounded in the source transcript';
  const active = item.jobs?.find((job) => ['running', 'queued', 'retry_wait'].includes(job.state));
  if (item.status === 'processing') return active ? `Preparing ${active.stage}…` : 'Preparing this knowledge page…';
  const problem = item.jobs?.find((job) => ['failed', 'blocked', 'cancelled'].includes(job.state));
  if (item.status === 'blocked') return problem?.lastErrorDetail ?? 'Processing needs your attention.';
  if (item.status === 'failed') return problem?.lastErrorDetail ?? 'Processing failed. You can retry this stage.';
  if (item.status === 'cancelled') return 'Processing was cancelled. Resume when you are ready.';
  return 'Discovered from your X bookmarks · waiting to process';
}

function trackActivity(itemId: string, type: 'item_opened' | 'citation_clicked' | 'note_saved', metadata?: Record<string, string | number | boolean>): void {
  void recordActivity(itemId, type, metadata).catch(() => undefined);
}

type Destination = 'today' | 'library' | 'topics' | 'connections' | 'ask';

const destinations: Array<{ id: Destination; label: string; mark: string }> = [
  { id: 'today', label: 'Today', mark: '◌' },
  { id: 'library', label: 'Library', mark: '□' },
  { id: 'topics', label: 'Topics', mark: '≡' },
  { id: 'connections', label: 'Connections', mark: '⌁' },
  { id: 'ask', label: 'Ask', mark: '?' },
];

function Rail({ current, onNavigate }: { current: Destination; onNavigate: (destination: Destination) => void }) {
  return <nav className="rail" aria-label="Primary navigation">
    <a className="brand-mark" href="#/today" aria-label="Field Theory home" onClick={(event) => { event.preventDefault(); onNavigate('today'); }}>FT</a>
    <div className="rail-destinations">
      {destinations.map((destination) => <a key={destination.id} href={`#/${destination.id}`} className={`rail-button${current === destination.id ? ' active' : ''}`} aria-current={current === destination.id ? 'page' : undefined} aria-label={destination.label} data-label={destination.label} onClick={(event) => { event.preventDefault(); onNavigate(destination.id); }}><span aria-hidden="true">{destination.mark}</span></a>)}
    </div>
  </nav>;
}

function MobileNavigation({ current, onNavigate }: { current: Destination; onNavigate: (destination: Destination) => void }) {
  return <nav className="mobile-nav" aria-label="Primary navigation">
    {destinations.filter((destination) => destination.id !== 'connections').map((destination) => <a key={destination.id} href={`#/${destination.id}`} aria-current={current === destination.id ? 'page' : undefined} onClick={(event) => { event.preventDefault(); onNavigate(destination.id); }}><span aria-hidden="true">{destination.mark}</span><span>{destination.label}</span></a>)}
  </nav>;
}

function TimestampButton({ milliseconds, onSeek, children }: { milliseconds: number; onSeek: (value: number) => void; children?: React.ReactNode }) {
  return <button className="timestamp" onClick={() => onSeek(milliseconds)} aria-label={`Seek to ${formatTimestamp(milliseconds)}`}>
    {children ?? formatTimestamp(milliseconds)}
  </button>;
}

export function ItemPage({ item, transcript, onLibrary, onOpen, onNavigate, onRefresh, initialSegmentId }: { item: KnowledgeItem; transcript: TranscriptSegment[]; onLibrary: () => void; onOpen: (id: string) => void; onNavigate?: (destination: Destination) => void; onRefresh?: () => Promise<void> | void; initialSegmentId?: string }) {
  const [tab, setTab] = useState<'chapters' | 'transcript'>(initialSegmentId ? 'transcript' : item.chapters?.length ? 'chapters' : 'transcript');
  const [note, setNote] = useState(item.note?.markdown ?? '');
  const [noteVersion, setNoteVersion] = useState<number | null>(item.note?.version ?? 0);
  const [noteState, setNoteState] = useState<'idle' | 'saving' | 'saved' | 'conflict' | 'error'>('idle');
  const [embedFailed, setEmbedFailed] = useState(false);
  const [question, setQuestion] = useState('');
  const [chat, setChat] = useState<ChatAnswer | null>(null);
  const [chatState, setChatState] = useState<'idle' | 'asking' | 'error'>('idle');
  const [jobState, setJobState] = useState<'idle' | 'working' | 'error'>('idle');
  const [related, setRelated] = useState<RelatedContentHit[] | null>(null);
  const [relatedState, setRelatedState] = useState<'idle' | 'loading' | 'error'>('idle');
  const [rememberedPassage, setRememberedPassage] = useState<TranscriptSegment | null>(null);
  const player = useRef<HTMLIFrameElement>(null);
  const audio = useRef<HTMLAudioElement>(null);
  const chapterTab = useRef<HTMLButtonElement>(null);
  const transcriptTab = useRef<HTMLButtonElement>(null);
  const initialSegment = useRef<HTMLButtonElement>(null);
  const embedOrigin = typeof window === 'undefined' ? undefined : window.location.origin;

  useEffect(() => { trackActivity(item.canonicalId, 'item_opened'); }, [item.canonicalId]);
  useEffect(() => { setRelated(null); setRelatedState('idle'); }, [item.canonicalId]);
  useEffect(() => {
    if (!initialSegmentId) return;
    setTab('transcript');
    const frame = window.requestAnimationFrame(() => {
      initialSegment.current?.focus({ preventScroll: true });
      initialSegment.current?.scrollIntoView({ block: 'center' });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [initialSegmentId]);

  const seek = (milliseconds: number) => {
    player.current?.contentWindow?.postMessage(JSON.stringify({ event: 'command', func: 'seekTo', args: [milliseconds / 1000, true] }), 'https://www.youtube-nocookie.com');
    if (audio.current) { audio.current.currentTime = milliseconds / 1000; void audio.current.play().catch(() => undefined); }
    trackActivity(item.canonicalId, 'citation_clicked', { startMs: milliseconds });
  };
  const persistNote = async () => {
    setNoteState('saving');
    try {
      const saved = await saveNote(item.canonicalId, note, noteVersion);
      setNoteVersion(saved.version);
      setNoteState('saved');
      trackActivity(item.canonicalId, 'note_saved');
    } catch (error) {
      setNoteState(error instanceof ApiError && error.code === 'note_conflict' ? 'conflict' : 'error');
    }
  };
  const selectTab = (next: 'chapters' | 'transcript') => {
    if (next === 'chapters' && !item.chapters?.length) return;
    setTab(next);
    (next === 'chapters' ? chapterTab : transcriptTab).current?.focus();
  };
  const onTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const hasChapters = Boolean(item.chapters?.length);
    if (event.key === 'Home') return selectTab(hasChapters ? 'chapters' : 'transcript');
    if (event.key === 'End' || !hasChapters) return selectTab('transcript');
    selectTab(tab === 'chapters' ? 'transcript' : 'chapters');
  };
  const ask = async () => {
    const value = question.trim();
    if (!value || chatState === 'asking') return;
    setChatState('asking');
    try {
      setChat(await askItem(item.canonicalId, value));
      setQuestion('');
      setChatState('idle');
    } catch {
      setChatState('error');
    }
  };
  const hasText = transcript.length > 0 || item.capabilities?.text === true;
  const canChat = item.capabilities?.chat ?? hasText;
  const hasSummary = Boolean(item.overview?.length);
  const hasEmbedding = item.capabilities?.embedding ?? false;
  const activeJob = item.jobs?.find((job) => ['running', 'queued', 'retry_wait'].includes(job.state));
  const problemJob = item.jobs?.find((job) => ['failed', 'blocked', 'cancelled'].includes(job.state));
  const prerequisiteBlocked = problemJob?.state === 'blocked' && ['binary_missing', 'whisper_binary_missing', 'whisper_model_missing', 'ffmpeg_missing', 'model_missing'].includes(problemJob.lastErrorCode ?? '');
  const runJobAction = async (action: 'retry' | 'cancel' | 'allow-long', jobId: string) => {
    setJobState('working');
    try {
      if (action === 'retry') await retryJob(item.canonicalId, jobId);
      else if (action === 'cancel') await cancelJob(item.canonicalId, jobId);
      else await allowLongTranscription(item.canonicalId, jobId);
      setJobState('idle');
      await onRefresh?.();
    } catch { setJobState('error'); }
  };

  return <div className="app-shell">
    <Rail current="library" onNavigate={(destination) => destination === 'library' ? onLibrary() : onNavigate?.(destination)} />
    <main className="reading-shell">
      <article className="document">
        <header className="item-header">
          <h1>{item.title}</h1>
          <p className="source-line"><span aria-hidden="true" className={`${item.type}-mark`} /> <a href={item.canonicalUrl} target="_blank" rel="noreferrer">{sourceLabel(item)}</a>{item.sourceRefs[0] ? <> · saved from X</> : null}</p>
        </header>

        {item.type === 'youtube' && item.videoId ? <div className="player-frame">
          {embedFailed ? <div className="embed-fallback"><p>This video cannot be embedded.</p><a href={item.canonicalUrl} target="_blank" rel="noreferrer">Open on YouTube ↗</a></div>
            : <iframe ref={player} src={youtubeEmbedUrl(item.videoId, embedOrigin)} title={item.title} allow="accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture" allowFullScreen onError={() => setEmbedFailed(true)} />}
        </div> : item.type === 'podcast' && item.mediaUrl ? <div className="podcast-player"><div><p className="eyebrow">Saved podcast</p><p>{Math.max(1, Math.round(item.durationMs / 60_000))} min</p></div><audio ref={audio} controls preload="metadata" src={item.mediaUrl}>Your browser cannot play this podcast. <a href={item.canonicalUrl}>Open the episode</a>.</audio></div>
          : <div className="article-intro"><p className="eyebrow">Saved article</p><p>{Math.max(1, Math.round(item.durationMs / 60_000))} min read</p></div>}
        <div className={`status-line status-${item.status}`} role="status">
          <span>{statusMessage(item)}</span>
          {problemJob ? <span className="status-actions">
            {problemJob.lastErrorCode === 'captions_unavailable' ? <button disabled={jobState === 'working'} onClick={() => { if (window.confirm('Allow local transcription beyond the normal two-hour limit for this item?')) void runJobAction('allow-long', problemJob.id); }}>Transcribe anyway</button> : null}
            {prerequisiteBlocked ? <span>Run <code>ft app doctor</code>, fix the missing prerequisite, then reload this page.</span>
              : <button disabled={jobState === 'working'} onClick={() => void runJobAction('retry', problemJob.id)}>Retry</button>}
          </span> : activeJob ? <span className="status-actions"><button disabled={jobState === 'working'} onClick={() => void runJobAction('cancel', activeJob.id)}>Cancel</button></span> : null}
          {jobState === 'error' ? <span>Could not update processing. Reload and try again.</span> : null}
        </div>

        <section className="source-surface" aria-label="Source navigation">
          <div className="tabs" role="tablist">
            <button ref={chapterTab} id="chapters-tab" role="tab" aria-selected={tab === 'chapters'} aria-controls="source-panel" tabIndex={tab === 'chapters' ? 0 : -1} onKeyDown={onTabKeyDown} onClick={() => selectTab('chapters')} disabled={!item.chapters?.length}>{item.type === 'article' ? 'Sections' : 'Chapters'}</button>
            <button ref={transcriptTab} id="transcript-tab" role="tab" aria-selected={tab === 'transcript'} aria-controls="source-panel" tabIndex={tab === 'transcript' ? 0 : -1} onKeyDown={onTabKeyDown} onClick={() => selectTab('transcript')}>{item.type === 'article' ? 'Article' : 'Transcript'}</button>
          </div>
          <div id="source-panel" className="source-list" role="tabpanel" aria-labelledby={tab === 'chapters' ? 'chapters-tab' : 'transcript-tab'}>
            {tab === 'chapters' ? item.chapters?.map((chapter) => <button className="source-row" key={`${chapter.startMs}-${chapter.label}`} onClick={() => seek(chapter.startMs)}><span>{item.type === 'article' ? '§' : formatTimestamp(chapter.startMs)}</span><strong>{chapter.label}</strong></button>)
              : transcript.length ? transcript.map((segment) => <div className="passage-row" id={`passage-${segment.id}`} key={segment.id}><button ref={segment.id === initialSegmentId ? initialSegment : undefined} className={`source-row transcript-row${segment.id === initialSegmentId ? ' search-match' : ''}`} aria-current={segment.id === initialSegmentId ? 'true' : undefined} onClick={() => seek(segment.startMs)}><span>{item.type === 'article' ? '¶' : formatTimestamp(segment.startMs)}</span><span>{segment.text}</span></button><button className="remember-passage" aria-label="Remember this passage" title={segment.text} onClick={() => setRememberedPassage(segment)}>Remember</button></div>)
                : <p className="empty-source">The transcript will appear here as processing completes.</p>}
          </div>
        </section>

        {rememberedPassage ? <section className="insight-draft" aria-labelledby="insight-draft-heading"><p className="eyebrow">Source passage</p><blockquote>{rememberedPassage.text}</blockquote><h2 id="insight-draft-heading">Your observation</h2><textarea aria-label="Your observation" rows={3} placeholder="What do you want to remember about this?" /><div><button onClick={() => setRememberedPassage(null)}>Cancel</button><button disabled title="Promotion becomes available when unified memory is enabled">Promote as insight</button></div></section> : null}

        <section className="notes-section">
          <label htmlFor="item-note">Notes</label>
          <textarea id="item-note" value={note} onChange={(event) => { setNote(event.target.value); setNoteState('idle'); }} placeholder="Add notes…" rows={3} />
          <div className="note-actions"><span aria-live="polite">{noteState === 'saving' ? 'Saving…' : noteState === 'saved' ? 'Saved' : noteState === 'conflict' ? 'A newer note exists. Your draft is preserved; copy it before reloading.' : noteState === 'error' ? 'Could not reach Field Theory. Your draft is preserved; try again.' : ''}</span><button onClick={persistNote} disabled={noteState === 'saving'}>Save note</button></div>
        </section>

        {hasSummary ? <section className="synthesis"><p className="eyebrow">Generated summary</p><h2>Overview</h2><ul>{item.overview!.map((claim, index) => <li key={index}>{claim.text} {claim.citations.map((citation) => <TimestampButton key={citation.startMs} milliseconds={citation.startMs} onSeek={seek}>{item.type === 'article' ? 'Open evidence' : undefined}</TimestampButton>)}</li>)}</ul></section> : hasText ? <section className="capability-note"><strong>Text is ready.</strong><span>The cited overview is still preparing. You can read, search, remember passages, and ask questions now.</span></section> : null}
        {item.details?.length ? <section className="synthesis"><h2>Details</h2>{item.details.map((claim, index) => <p key={index}>{claim.text} {claim.citations.map((citation) => <TimestampButton key={citation.startMs} milliseconds={citation.startMs} onSeek={seek}>{item.type === 'article' ? 'Open evidence' : undefined}</TimestampButton>)}</p>)}</section> : null}
        <section className="related-section" aria-labelledby="related-heading">
          <div><h2 id="related-heading">Related in your library</h2><p>{hasEmbedding ? 'Semantic similarity with supporting evidence.' : 'Keyword-only while local embeddings are unavailable.'}</p></div>
          {related === null ? <button disabled={relatedState === 'loading'} onClick={() => {
            setRelatedState('loading');
            void getRelatedItems(item.canonicalId).then((hits) => { setRelated(hits); setRelatedState('idle'); }).catch(() => setRelatedState('error'));
          }}>{relatedState === 'loading' ? 'Finding…' : relatedState === 'error' ? 'Try again' : 'Find related'}</button> : related.length ? <div className="related-list">
            {related.map((hit) => <button key={hit.item.canonicalId} onClick={() => onOpen(hit.item.canonicalId)}>
              <span><strong>{hit.item.title}</strong><span>{hit.item.creator}</span></span><span>{Math.round(hit.score * 100)}%</span>
            </button>)}
          </div> : <p className="related-empty">No strong connections yet. A few more prepared items will make this useful.</p>}
        </section>
        {chat ? <section className={`chat-answer ${chat.refused ? 'chat-refused' : ''}`} aria-live="polite"><p className="eyebrow">Answer</p><p>{chat.answer}</p>{chat.citations.length ? <div className="chat-citations">{chat.citations.map((citation) => <TimestampButton key={citation.segmentId} milliseconds={citation.startMs} onSeek={seek} />)}</div> : null}</section> : null}
      </article>
      <form className="composer" onSubmit={(event) => { event.preventDefault(); void ask(); }}>
        <label className="sr-only" htmlFor="question">Ask about this {item.type === 'article' ? 'article' : item.type === 'podcast' ? 'podcast' : 'video'}</label>
        <input id="question" value={question} onChange={(event) => { setQuestion(event.target.value); setChatState('idle'); }} placeholder={chatState === 'error' ? 'Could not answer. Try again…' : `Ask anything about this ${item.type === 'article' ? 'article' : item.type === 'podcast' ? 'podcast' : 'video'}…`} disabled={!canChat || chatState === 'asking'} maxLength={2000} />
        <span>{canChat ? chatState === 'asking' ? 'Reading source…' : 'Grounded in transcript and source passages' : 'Available when ready — text is still processing'}</span>
        <button type="submit" disabled={!canChat || chatState === 'asking' || !question.trim()} aria-label="Ask">↑</button>
      </form>
      <MobileNavigation current="library" onNavigate={(destination) => destination === 'library' ? onLibrary() : onNavigate?.(destination)} />
    </main>
  </div>;
}

function relativeSync(health: SyncHealth | null): string {
  if (!health) return 'Local library';
  if (health.state === 'syncing') return 'Syncing new saves…';
  if (health.state === 'auth_expired') return 'X sync needs reconnecting';
  if (health.state === 'stale' || health.state === 'error') return health.message ?? 'Sync is delayed';
  if (!health.lastSuccessAt) return 'Ready to sync';
  const minutes = Math.max(0, Math.round((Date.now() - new Date(health.lastSuccessAt).getTime()) / 60_000));
  return minutes < 1 ? 'Synced just now' : `Synced ${minutes}m ago`;
}

function AddCapture({ onClose, onOpen }: { onClose: () => void; onOpen: (id: string) => void }) {
  const [url, setUrl] = useState('');
  const [receipt, setReceipt] = useState<CaptureReceipt | null>(null);
  const [state, setState] = useState<'idle' | 'adding' | 'error'>('idle');
  const submit = async () => {
    const value = url.trim();
    if (!/^https?:\/\//i.test(value)) { setState('error'); return; }
    setState('adding');
    try { setReceipt(await addCapture(value)); setState('idle'); }
    catch { setReceipt({ originalUrl: value, state: 'needs_access', message: 'Automatic capture is unavailable. The URL is preserved here; open the original or try again after the local service is updated.' }); setState('idle'); }
  };
  return <div className="capture-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}>
    <section className="capture-dialog" role="dialog" aria-modal="true" aria-labelledby="capture-heading">
      <div className="dialog-heading"><div><p className="eyebrow">Capture</p><h2 id="capture-heading">Add something worth remembering</h2></div><button aria-label="Close Add URL" onClick={onClose}>×</button></div>
      {!receipt ? <form onSubmit={(event) => { event.preventDefault(); void submit(); }}><label htmlFor="capture-url">Video, podcast, or article URL</label><input id="capture-url" type="url" autoFocus value={url} onChange={(event) => { setUrl(event.target.value); setState('idle'); }} placeholder="https://…" /><p>Field Theory will resolve the source, preserve its provenance, and prepare what it can locally.</p>{state === 'error' ? <p role="alert">Enter a complete http or https URL.</p> : null}<div className="dialog-actions"><button type="button" onClick={onClose}>Cancel</button><button type="submit" disabled={state === 'adding'}>{state === 'adding' ? 'Resolving…' : 'Add URL'}</button></div></form>
        : <div className="capture-receipt" role="status"><p className="receipt-state">{receipt.state.replace('_', ' ')}</p><h3>{receipt.state === 'duplicate' ? 'Already in your library' : receipt.state === 'needs_access' ? 'This source needs help' : 'Capture received'}</h3><p>{receipt.message}</p><a href={receipt.originalUrl} target="_blank" rel="noreferrer">Open original ↗</a><div className="dialog-actions"><button onClick={onClose}>Done</button>{receipt.itemId ? <button onClick={() => onOpen(receipt.itemId!)}>Open item</button> : null}</div></div>}
    </section>
  </div>;
}

function SurfaceHeader({ eyebrow, title, description, health, onAdd }: { eyebrow: string; title: string; description: string; health: SyncHealth | null; onAdd: () => void }) {
  return <header className="surface-header"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p>{description}</p></div><div className="surface-actions"><span className={health && ['stale', 'auth_expired', 'error'].includes(health.state) ? 'sync-warning' : ''} role="status">{relativeSync(health)}</span><button onClick={onAdd}>＋ Add</button></div></header>;
}

function fallbackMemories(items: KnowledgeItem[]): TodayMemory[] {
  const ready = items.filter((item) => item.status === 'ready' && item.overview?.length).slice(0, 3);
  const kinds: TodayMemory['kind'][] = ['newly_ready', 'prior_memory', 'evolving_topic'];
  return ready.map((item, index) => ({
    id: `fallback:${item.canonicalId}`, itemId: item.canonicalId, kind: kinds[index] ?? 'prior_memory',
    label: index === 0 ? 'Newly ready' : index === 1 ? 'Worth remembering' : 'A thread to follow', title: item.title,
    whyNow: index === 0 ? 'This recent save is ready to skim.' : 'A prior source may connect to what you are exploring now.', provenance: 'generated',
    evidence: [{ sourceId: item.canonicalId, sourceTitle: item.title, preview: item.overview?.[0]?.text ?? '', startMs: item.overview?.[0]?.citations[0]?.startMs }],
  }));
}

function MemoryCard({ memory, onOpen }: { memory: TodayMemory; onOpen: (id: string) => void }) {
  const [choice, setChoice] = useState<'keep' | 'dismiss' | 'applied' | null>(null);
  const choose = (next: 'keep' | 'dismiss' | 'applied') => { setChoice(next); void recordMemoryFeedback(memory.id, next); };
  if (choice === 'dismiss') return <article className="memory-card dismissed"><p>Dismissed. Nothing was deleted.</p><button onClick={() => setChoice(null)}>Undo</button></article>;
  return <article className="memory-card">
    <div className="memory-label"><span>{memory.label}</span><span>{memory.provenance === 'authored' ? 'Your insight' : memory.provenance === 'generated' ? 'Generated connection' : 'Saved source'}</span></div>
    <h2>{memory.title}</h2><p className="why-now"><strong>Why now:</strong> {memory.whyNow}</p>
    {memory.evidence[0] ? <blockquote>“{memory.evidence[0].preview}”<cite>{memory.evidence[0].sourceUrl ? <a href={memory.evidence[0].sourceUrl} target="_blank" rel="noreferrer">{memory.evidence[0].location ?? 'View saved source'} ↗</a> : memory.evidence[0].location ?? memory.evidence[0].sourceTitle}</cite></blockquote> : null}
    <div className="memory-actions">{memory.itemId ? <button onClick={() => onOpen(memory.itemId!)}>Open evidence</button> : null}<button aria-pressed={choice === 'keep'} onClick={() => choose('keep')}>Keep</button><button onClick={() => choose('dismiss')}>Dismiss</button><button aria-pressed={choice === 'applied'} onClick={() => choose('applied')}>Applied</button></div>
  </article>;
}

function TodayPage({ items, memories, health, onOpen, onAdd }: { items: KnowledgeItem[]; memories: TodayMemory[]; health: SyncHealth | null; onOpen: (id: string) => void; onAdd: () => void }) {
  const useful = (memories.length ? memories : fallbackMemories(items)).slice(0, 3);
  return <main className="surface-shell"><SurfaceHeader eyebrow="Today" title="Worth revisiting" description="Up to three items you saved, each with its original source and a concrete reason to return." health={health} onAdd={onAdd} />
    {useful.length ? <section className="memory-feed" aria-label="Today's useful memories">{useful.map((memory) => <MemoryCard key={memory.id} memory={memory} onOpen={onOpen} />)}</section>
      : <section className="settled-empty"><p className="eyebrow">All caught up</p><h2>Nothing else needs your attention.</h2><p>As sources become useful, Field Theory will bring back at most three with a clear reason.</p></section>}
  </main>;
}

function TopicsPage({ topics, health, onAdd }: { topics: MemoryTopic[]; health: SyncHealth | null; onAdd: () => void }) {
  return <main className="surface-shell"><SurfaceHeader eyebrow="Topics" title="Themes in your memory" description="Stable, explainable groups built from sources and your own observations." health={health} onAdd={onAdd} />
    {topics.length ? <section className="editorial-list" aria-label="Topics">{topics.map((topic) => <article key={topic.id}><div><p className="eyebrow">{topic.itemCount} memories{topic.confidence !== undefined ? ` · ${Math.round(topic.confidence * 100)}% confidence` : ''}</p><h2>{topic.label}</h2><p>{topic.description ?? topic.representativeTerms?.join(' · ')}</p>{topic.recentChange ? <p><strong>Recent change:</strong> {topic.recentChange}</p> : null}</div><span aria-hidden="true">→</span></article>)}</section>
      : <section className="settled-empty"><p className="eyebrow">Not enough evidence yet</p><h2>Topics will form without forcing every source into a box.</h2><p>Keyword search and readable sources remain available while local embeddings prepare.</p></section>}
  </main>;
}

function ConnectionsPage({ connections, health, onAdd, onOpen }: { connections: MemoryConnection[]; health: SyncHealth | null; onAdd: () => void; onOpen: (id: string) => void }) {
  return <main className="surface-shell"><SurfaceHeader eyebrow="Connections" title="Ideas in conversation" description="Every relationship includes a reason and source evidence." health={health} onAdd={onAdd} />
    {connections.length ? <section className="connections-list" aria-label="Connections">{connections.map((connection) => <article key={connection.id}><div className="connection-titles"><button onClick={() => onOpen(connection.fromId)}>{connection.fromTitle}</button><span>{connection.relation}</span><button onClick={() => onOpen(connection.toId)}>{connection.toTitle}</button></div><p>{connection.explanation}</p>{connection.evidence[0] ? <blockquote>“{connection.evidence[0].preview}”<cite>{connection.evidence[0].sourceTitle}</cite></blockquote> : null}<div className="connection-feedback" aria-label="Was this connection useful?"><span>Was this useful?</span>{(['useful', 'obvious', 'wrong'] as const).map((answer) => <button key={answer} onClick={() => void recordMemoryFeedback(connection.id, answer)}>{answer}</button>)}</div></article>)}</section>
      : <section className="settled-empty"><p className="eyebrow">No defensible connections yet</p><h2>Field Theory will wait for evidence.</h2><p>It will not invent a relationship just to fill this page.</p></section>}
  </main>;
}

function AskPage({ health, onAdd, onOpen }: { health: SyncHealth | null; onAdd: () => void; onOpen: (id: string) => void }) {
  const [question, setQuestion] = useState(''); const [answer, setAnswer] = useState<CorpusAnswer | null>(null); const [state, setState] = useState<'idle' | 'asking' | 'unavailable'>('idle');
  const ask = async () => { if (!question.trim()) return; setState('asking'); const next = await askCorpus(question.trim(), { topic: 'all', date: 'any', sources: 'all', projects: 'current' }); setAnswer(next); setState(next ? 'idle' : 'unavailable'); };
  return <main className="surface-shell ask-surface"><SurfaceHeader eyebrow="Ask" title="Ask your memory" description="Compare sources, find disagreements, and trace how an idea changed." health={health} onAdd={onAdd} />
    <div className="scope-row" aria-label="Answer scope"><button>Topic: all</button><button>Date: any</button><button>Sources: all</button><button>Projects: current</button></div>
    <form className="corpus-composer" onSubmit={(event) => { event.preventDefault(); void ask(); }}><label className="sr-only" htmlFor="corpus-question">Question for your memory</label><textarea id="corpus-question" value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="What have I saved about…" rows={3} /><div><span>Answers cite the passages they use.</span><button disabled={!question.trim() || state === 'asking'}>{state === 'asking' ? 'Reading…' : 'Ask'}</button></div></form>
    {state === 'unavailable' ? <section className="capability-note" role="status"><strong>Corpus synthesis is not available yet.</strong><span>Your library and exact search still work while unified retrieval finishes preparing.</span></section> : null}
    {answer ? <section className="corpus-answer" aria-live="polite"><p className="eyebrow">{answer.refused ? 'Not enough evidence' : answer.partial ? 'Partial answer' : 'Cited synthesis'}</p><h2>{answer.answer}</h2>{answer.claims?.map((claim, index) => <article key={index}><h3>{claim.heading ?? `Claim ${index + 1}`}</h3><p>{claim.text}</p><EvidenceList evidence={claim.evidence} onOpen={onOpen} /></article>)}{!answer.claims?.length ? <EvidenceList evidence={answer.evidence} onOpen={onOpen} /> : null}<button disabled title="Promotion requires an explicit provenance preview">Save as insight</button></section> : null}
  </main>;
}

function EvidenceList({ evidence, onOpen }: { evidence: CorpusAnswer['evidence']; onOpen: (id: string) => void }) {
  return <div className="evidence-list">{evidence.map((entry, index) => <button key={`${entry.sourceId}-${index}`} disabled={!entry.sourceId} onClick={() => entry.sourceId && onOpen(entry.sourceId)}><span>{entry.sourceTitle}{entry.location ? ` · ${entry.location}` : ''}</span><span>{entry.preview}</span>{entry.reason ? <small>Why retrieved: {entry.reason}</small> : null}</button>)}</div>;
}

function EmptyLibrary() {
  return <main className="empty-library"><p className="eyebrow">Your Library</p><h1>Bookmark something worth understanding.</h1><p>Field Theory will quietly prepare saved videos, podcasts, and X articles as cited reading pages here.</p></main>;
}

type LibraryFilter = 'inbox' | 'ready' | 'processing' | 'attention';

export function LibraryPage({ items, onOpen, onNavigate, health = null, onAdd }: { items: KnowledgeItem[]; onOpen: (id: string, segmentId?: string) => void; onNavigate?: (destination: Destination) => void; health?: SyncHealth | null; onAdd?: () => void }) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<LibraryFilter>('inbox');
  const [searchMode, setSearchMode] = useState<'best' | 'exact'>('best');
  const [results, setResults] = useState<ContentSearchHit[] | null>(null);
  const [searchState, setSearchState] = useState<'idle' | 'searching' | 'error'>('idle');
  useEffect(() => {
    const value = query.trim();
    if (value.length < 2) { setResults(null); setSearchState('idle'); return; }
    const controller = new AbortController();
    setResults(null);
    setSearchState('searching');
    const timer = window.setTimeout(() => {
      void searchContent(value, 20, controller.signal).then((hits) => {
        if (controller.signal.aborted) return;
        setResults(hits); setSearchState('idle');
      }).catch(() => { if (!controller.signal.aborted) { setResults(null); setSearchState('error'); } });
    }, 180);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [query]);
  const filtered = items.filter((item) => filter === 'inbox' ? item.lifecycle !== 'dismissed' && item.lifecycle !== 'archived' : filter === 'ready' ? item.status === 'ready' : filter === 'processing' ? item.status === 'processing' || item.status === 'discovered' : ['failed', 'blocked', 'cancelled'].includes(item.status));
  return <div className="app-shell">
    <Rail current="library" onNavigate={(destination) => onNavigate?.(destination)} />
    <main className="library-shell">
      <header className="library-header"><div><p className="eyebrow">Your Library</p><h1>Saved understanding</h1><p>Videos, podcasts, articles, and authored memory prepared quietly in the background.</p></div>{onAdd ? <div className="surface-actions"><span role="status">{relativeSync(health)}</span><button onClick={onAdd}>＋ Add</button></div> : null}</header>
      <div className="library-filters" role="tablist" aria-label="Library status">
        {([['inbox', 'Inbox'], ['ready', 'Ready'], ['processing', 'Processing'], ['attention', 'Needs attention']] as Array<[LibraryFilter, string]>).map(([id, label]) => <button key={id} role="tab" aria-selected={filter === id} onClick={() => setFilter(id)}>{label}<span>{items.filter((item) => id === 'inbox' ? item.lifecycle !== 'dismissed' && item.lifecycle !== 'archived' : id === 'ready' ? item.status === 'ready' : id === 'processing' ? item.status === 'processing' || item.status === 'discovered' : ['failed', 'blocked', 'cancelled'].includes(item.status)).length}</span></button>)}
      </div>
      <div className="library-search">
        <label className="sr-only" htmlFor="library-search">Search saved sources</label>
        <span aria-hidden="true">⌕</span>
        <input id="library-search" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search titles, summaries, and transcripts…" autoComplete="off" maxLength={500} />
        <button className="search-mode" aria-label={`Search mode: ${searchMode}`} onClick={() => setSearchMode(searchMode === 'best' ? 'exact' : 'best')}>{searchMode === 'best' ? 'Best' : 'Exact'}</button>
        <span role="status" aria-live="polite">{searchState === 'searching' ? 'Searching…' : searchState === 'error' ? 'Search unavailable' : results ? `${results.length} result${results.length === 1 ? '' : 's'}` : ''}</span>
      </div>
      {results ? <section className="search-results" aria-label="Search results">
        {results.length ? results.map((hit, index) => <button key={`${hit.item.canonicalId}-${hit.segmentId ?? hit.matchType}-${index}`} className="search-result" onClick={() => onOpen(hit.item.canonicalId, hit.segmentId)}>
          <span className="search-result-type">{hit.matchType === 'transcript' && hit.startMs !== undefined ? formatTimestamp(hit.startMs) : hit.matchType}</span>
          <span><strong>{hit.item.title}</strong><span>{hit.excerpt}</span></span>
          <span aria-hidden="true">→</span>
        </button>) : <p className="search-empty">Nothing in your saved library matches “{query.trim()}”.</p>}
      </section> : <section className="library-list" aria-label="Knowledge pages">
        {filtered.length ? filtered.map((item) => <button key={item.canonicalId} className="library-item" onClick={() => onOpen(item.canonicalId)}>
          {item.thumbnailUrl ? <img src={item.thumbnailUrl} alt="" loading="lazy" /> : <span className="library-placeholder" aria-hidden="true">{item.type === 'article' ? '≡' : item.type === 'podcast' ? '●' : '▶'}</span>}
          <span className="library-copy"><strong>{item.title}</strong><span>{item.creator}</span></span>
          <span className={`library-status status-${item.status}`}>{item.status === 'ready' ? 'Ready' : item.status === 'processing' ? 'Preparing…' : item.status}</span>
        </button>) : <div className="filter-empty"><h2>Nothing here needs clearing.</h2><p>Try another filter or add a source you want to understand.</p></div>}
      </section>}
    </main>
    <MobileNavigation current="library" onNavigate={(destination) => onNavigate?.(destination)} />
  </div>;
}

export default function App() {
  const [items, setItems] = useState<KnowledgeItem[] | null>(null);
  const [selected, setSelected] = useState<KnowledgeItem | null>(null);
  const [transcript, setTranscript] = useState<TranscriptSegment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const initialDestination = typeof window === 'undefined' ? 'today' : window.location.hash.match(/^#\/(today|library|topics|connections|ask)/)?.[1] as Destination | undefined;
  const [destination, setDestination] = useState<Destination>(initialDestination ?? 'today');
  const [initialSegmentId, setInitialSegmentId] = useState<string | undefined>();
  const [today, setToday] = useState<TodayMemory[]>([]);
  const [topics, setTopics] = useState<MemoryTopic[]>([]);
  const [connections, setConnections] = useState<MemoryConnection[]>([]);
  const [syncHealth, setSyncHealth] = useState<SyncHealth | null>(null);
  const [showCapture, setShowCapture] = useState(false);

  const loadLibrary = async () => {
    setError(null);
    try {
      const values = await listItems();
      setItems(values);
      const [todayValues, topicValues, connectionValues, health] = await Promise.all([getToday(), getTopics(), getConnections(), getSyncHealth()]);
      setToday(todayValues); setTopics(topicValues); setConnections(connectionValues); setSyncHealth(health);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const openItem = async (id: string, segmentId?: string) => {
    setError(null);
    try {
      const item = await getItem(id);
      setSelected(item); setTranscript(await getTranscript(id)); setInitialSegmentId(segmentId);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  useEffect(() => { void loadLibrary(); }, []);
  useEffect(() => {
    const onHash = () => { const next = window.location.hash.match(/^#\/(today|library|topics|connections|ask)/)?.[1] as Destination | undefined; if (next) { setSelected(null); setDestination(next); } };
    window.addEventListener('hashchange', onHash); return () => window.removeEventListener('hashchange', onHash);
  }, []);
  useEffect(() => {
    if (!selected || selected.status !== 'processing') return;
    const timer = window.setInterval(() => {
      void Promise.all([getItem(selected.canonicalId), getTranscript(selected.canonicalId)]).then(([item, segments]) => {
        setSelected(item); setTranscript(segments);
      }).catch(() => undefined);
    }, 1_500);
    return () => window.clearInterval(timer);
  }, [selected?.canonicalId, selected?.status]);

  const navigate = (next: Destination) => { setSelected(null); setInitialSegmentId(undefined); setDestination(next); window.location.hash = `/${next}`; };
  const appChrome = (content: React.ReactNode) => <div className="app-shell"><Rail current={destination} onNavigate={navigate} />{content}<MobileNavigation current={destination} onNavigate={navigate} />{showCapture ? <AddCapture onClose={() => setShowCapture(false)} onOpen={(id) => { setShowCapture(false); void openItem(id); }} /> : null}</div>;

  if (error) return appChrome(<main className="empty-library"><p className="eyebrow">Field Theory</p><h1>Couldn’t open the library.</h1><p>{error}</p><button onClick={() => void loadLibrary()}>Try again</button></main>);
  if (items === null) return <main className="empty-library" aria-busy="true"><p>Opening your library…</p></main>;
  if (items.length === 0) return <EmptyLibrary />;
  if (!selected) {
    if (destination === 'library') return <LibraryPage items={items} health={syncHealth} onAdd={() => setShowCapture(true)} onNavigate={navigate} onOpen={(id, segmentId) => void openItem(id, segmentId)} />;
    if (destination === 'topics') return appChrome(<TopicsPage topics={topics} health={syncHealth} onAdd={() => setShowCapture(true)} />);
    if (destination === 'connections') return appChrome(<ConnectionsPage connections={connections} health={syncHealth} onAdd={() => setShowCapture(true)} onOpen={(id) => void openItem(id)} />);
    if (destination === 'ask') return appChrome(<AskPage health={syncHealth} onAdd={() => setShowCapture(true)} onOpen={(id) => void openItem(id)} />);
    return appChrome(<TodayPage items={items} memories={today} health={syncHealth} onAdd={() => setShowCapture(true)} onOpen={(id) => void openItem(id)} />);
  }
  return <ItemPage item={selected} transcript={transcript} initialSegmentId={initialSegmentId} onOpen={(id) => void openItem(id)} onNavigate={navigate} onLibrary={() => { navigate('library'); void loadLibrary(); }} onRefresh={async () => {
    setSelected(await getItem(selected.canonicalId));
    setTranscript(await getTranscript(selected.canonicalId));
  }} />;
}
