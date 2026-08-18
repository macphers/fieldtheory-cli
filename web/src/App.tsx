import React, { useEffect, useRef, useState } from 'react';
import { ApiError, allowLongTranscription, askItem, cancelJob, getItem, getRelatedItems, getTranscript, listItems, recordActivity, retryJob, saveNote, searchContent } from './api';
import type { ChatAnswer, ContentSearchHit, KnowledgeItem, RelatedContentHit, TranscriptSegment } from './types';

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

function Rail({ onLibrary }: { onLibrary: () => void }) {
  return <nav className="rail" aria-label="Primary navigation">
    <button className="rail-button" aria-label="Back" onClick={() => history.back()}>←</button>
    <button className="rail-button" aria-label="Library" onClick={onLibrary}>□</button>
  </nav>;
}

function TimestampButton({ milliseconds, onSeek, children }: { milliseconds: number; onSeek: (value: number) => void; children?: React.ReactNode }) {
  return <button className="timestamp" onClick={() => onSeek(milliseconds)} aria-label={`Seek to ${formatTimestamp(milliseconds)}`}>
    {children ?? formatTimestamp(milliseconds)}
  </button>;
}

export function ItemPage({ item, transcript, onLibrary, onOpen, onRefresh, initialSegmentId }: { item: KnowledgeItem; transcript: TranscriptSegment[]; onLibrary: () => void; onOpen: (id: string) => void; onRefresh?: () => Promise<void> | void; initialSegmentId?: string }) {
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
    <Rail onLibrary={onLibrary} />
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
            {tab === 'chapters' ? item.chapters?.map((chapter) => <button className="source-row" key={`${chapter.startMs}-${chapter.label}`} onClick={() => seek(chapter.startMs)}><span>{formatTimestamp(chapter.startMs)}</span><strong>{chapter.label}</strong></button>)
              : transcript.length ? transcript.map((segment) => <button ref={segment.id === initialSegmentId ? initialSegment : undefined} className={`source-row transcript-row${segment.id === initialSegmentId ? ' search-match' : ''}`} aria-current={segment.id === initialSegmentId ? 'true' : undefined} key={segment.id} onClick={() => seek(segment.startMs)}><span>{formatTimestamp(segment.startMs)}</span><span>{segment.text}</span></button>)
                : <p className="empty-source">The transcript will appear here as processing completes.</p>}
          </div>
        </section>

        <section className="notes-section">
          <label htmlFor="item-note">Notes</label>
          <textarea id="item-note" value={note} onChange={(event) => { setNote(event.target.value); setNoteState('idle'); }} placeholder="Add notes…" rows={3} />
          <div className="note-actions"><span aria-live="polite">{noteState === 'saving' ? 'Saving…' : noteState === 'saved' ? 'Saved' : noteState === 'conflict' ? 'A newer note exists. Your draft is preserved; copy it before reloading.' : noteState === 'error' ? 'Could not reach Field Theory. Your draft is preserved; try again.' : ''}</span><button onClick={persistNote} disabled={noteState === 'saving'}>Save note</button></div>
        </section>

        {item.overview?.length ? <section className="synthesis"><h2>Overview</h2><ul>{item.overview.map((claim, index) => <li key={index}>{claim.text} {claim.citations.map((citation) => <TimestampButton key={citation.startMs} milliseconds={citation.startMs} onSeek={seek} />)}</li>)}</ul></section> : null}
        {item.details?.length ? <section className="synthesis"><h2>Details</h2>{item.details.map((claim, index) => <p key={index}>{claim.text} {claim.citations.map((citation) => <TimestampButton key={citation.startMs} milliseconds={citation.startMs} onSeek={seek} />)}</p>)}</section> : null}
        <section className="related-section" aria-labelledby="related-heading">
          <div><h2 id="related-heading">Related in your library</h2><p>Local similarity across titles, summaries, and transcripts.</p></div>
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
        <input id="question" value={question} onChange={(event) => { setQuestion(event.target.value); setChatState('idle'); }} placeholder={chatState === 'error' ? 'Could not answer. Try again…' : `Ask anything about this ${item.type === 'article' ? 'article' : item.type === 'podcast' ? 'podcast' : 'video'}…`} disabled={item.status !== 'ready' || chatState === 'asking'} maxLength={2000} />
        <span>{item.status === 'ready' ? chatState === 'asking' ? 'Reading transcript…' : 'Grounded in transcript' : 'Available when ready'}</span>
        <button type="submit" disabled={item.status !== 'ready' || chatState === 'asking' || !question.trim()} aria-label="Ask">↑</button>
      </form>
    </main>
  </div>;
}

function EmptyLibrary() {
  return <main className="empty-library"><p className="eyebrow">Your Library</p><h1>Bookmark something worth understanding.</h1><p>Field Theory will quietly prepare saved videos, podcasts, and X articles as cited reading pages here.</p></main>;
}

export function LibraryPage({ items, onOpen }: { items: KnowledgeItem[]; onOpen: (id: string, segmentId?: string) => void }) {
  const [query, setQuery] = useState('');
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
  return <div className="app-shell">
    <Rail onLibrary={() => undefined} />
    <main className="library-shell">
      <header className="library-header"><p className="eyebrow">Your Library</p><h1>Saved understanding</h1><p>Videos, podcasts, and articles discovered from your X bookmarks, prepared quietly in the background.</p></header>
      <div className="library-search">
        <label className="sr-only" htmlFor="library-search">Search saved sources</label>
        <span aria-hidden="true">⌕</span>
        <input id="library-search" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search titles, summaries, and transcripts…" autoComplete="off" maxLength={500} />
        <span role="status" aria-live="polite">{searchState === 'searching' ? 'Searching…' : searchState === 'error' ? 'Search unavailable' : results ? `${results.length} result${results.length === 1 ? '' : 's'}` : ''}</span>
      </div>
      {results ? <section className="search-results" aria-label="Search results">
        {results.length ? results.map((hit, index) => <button key={`${hit.item.canonicalId}-${hit.segmentId ?? hit.matchType}-${index}`} className="search-result" onClick={() => onOpen(hit.item.canonicalId, hit.segmentId)}>
          <span className="search-result-type">{hit.matchType === 'transcript' && hit.startMs !== undefined ? formatTimestamp(hit.startMs) : hit.matchType}</span>
          <span><strong>{hit.item.title}</strong><span>{hit.excerpt}</span></span>
          <span aria-hidden="true">→</span>
        </button>) : <p className="search-empty">Nothing in your saved library matches “{query.trim()}”.</p>}
      </section> : <section className="library-list" aria-label="Knowledge pages">
        {items.map((item) => <button key={item.canonicalId} className="library-item" onClick={() => onOpen(item.canonicalId)}>
          {item.thumbnailUrl ? <img src={item.thumbnailUrl} alt="" loading="lazy" /> : <span className="library-placeholder" aria-hidden="true">{item.type === 'article' ? '≡' : item.type === 'podcast' ? '●' : '▶'}</span>}
          <span className="library-copy"><strong>{item.title}</strong><span>{item.creator}</span></span>
          <span className={`library-status status-${item.status}`}>{item.status === 'ready' ? 'Ready' : item.status === 'processing' ? 'Preparing…' : item.status}</span>
        </button>)}
      </section>}
    </main>
  </div>;
}

export default function App() {
  const [items, setItems] = useState<KnowledgeItem[] | null>(null);
  const [selected, setSelected] = useState<KnowledgeItem | null>(null);
  const [transcript, setTranscript] = useState<TranscriptSegment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showLibrary, setShowLibrary] = useState(true);
  const [initialSegmentId, setInitialSegmentId] = useState<string | undefined>();

  const loadLibrary = async () => {
    setError(null);
    try {
      const values = await listItems();
      setItems(values);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const openItem = async (id: string, segmentId?: string) => {
    setError(null);
    try {
      const item = await getItem(id);
      setSelected(item); setTranscript(await getTranscript(id)); setInitialSegmentId(segmentId); setShowLibrary(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  useEffect(() => { void loadLibrary(); }, []);
  useEffect(() => {
    if (!selected || selected.status !== 'processing') return;
    const timer = window.setInterval(() => {
      void Promise.all([getItem(selected.canonicalId), getTranscript(selected.canonicalId)]).then(([item, segments]) => {
        setSelected(item); setTranscript(segments);
      }).catch(() => undefined);
    }, 1_500);
    return () => window.clearInterval(timer);
  }, [selected?.canonicalId, selected?.status]);

  if (error) return <main className="empty-library"><p className="eyebrow">Field Theory</p><h1>Couldn’t open the library.</h1><p>{error}</p><button onClick={() => void loadLibrary()}>Try again</button></main>;
  if (items === null) return <main className="empty-library" aria-busy="true"><p>Opening your library…</p></main>;
  if (items.length === 0) return <EmptyLibrary />;
  if (showLibrary) return <LibraryPage items={items} onOpen={(id, segmentId) => void openItem(id, segmentId)} />;
  if (!selected) return <main className="empty-library" aria-busy="true"><p>Preparing the page…</p></main>;
  return <ItemPage item={selected} transcript={transcript} initialSegmentId={initialSegmentId} onOpen={(id) => void openItem(id)} onLibrary={() => { setInitialSegmentId(undefined); setShowLibrary(true); void loadLibrary(); }} onRefresh={async () => {
    setSelected(await getItem(selected.canonicalId));
    setTranscript(await getTranscript(selected.canonicalId));
  }} />;
}
