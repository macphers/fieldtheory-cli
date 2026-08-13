import React, { useEffect, useRef, useState } from 'react';
import { askItem, getItem, getTranscript, listItems, recordActivity, saveNote } from './api';
import type { ChatAnswer, KnowledgeItem, TranscriptSegment } from './types';

export function formatTimestamp(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function youtubeEmbedUrl(videoId: string): string {
  return `https://www.youtube-nocookie.com/embed/${encodeURIComponent(videoId)}?enablejsapi=1&rel=0`;
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
    <button className="rail-more" aria-label="Settings">•••</button>
  </nav>;
}

function TimestampButton({ milliseconds, onSeek, children }: { milliseconds: number; onSeek: (value: number) => void; children?: React.ReactNode }) {
  return <button className="timestamp" onClick={() => onSeek(milliseconds)} aria-label={`Seek to ${formatTimestamp(milliseconds)}`}>
    {children ?? formatTimestamp(milliseconds)}
  </button>;
}

export function ItemPage({ item, transcript, onLibrary }: { item: KnowledgeItem; transcript: TranscriptSegment[]; onLibrary: () => void }) {
  const [tab, setTab] = useState<'chapters' | 'transcript'>(item.chapters?.length ? 'chapters' : 'transcript');
  const [note, setNote] = useState(item.note?.markdown ?? '');
  const [noteVersion, setNoteVersion] = useState<number | null>(item.note?.version ?? 0);
  const [noteState, setNoteState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [embedFailed, setEmbedFailed] = useState(false);
  const [question, setQuestion] = useState('');
  const [chat, setChat] = useState<ChatAnswer | null>(null);
  const [chatState, setChatState] = useState<'idle' | 'asking' | 'error'>('idle');
  const player = useRef<HTMLIFrameElement>(null);

  useEffect(() => { trackActivity(item.canonicalId, 'item_opened'); }, [item.canonicalId]);

  const seek = (milliseconds: number) => {
    player.current?.contentWindow?.postMessage(JSON.stringify({ event: 'command', func: 'seekTo', args: [milliseconds / 1000, true] }), 'https://www.youtube-nocookie.com');
    trackActivity(item.canonicalId, 'citation_clicked', { startMs: milliseconds });
  };
  const persistNote = async () => {
    setNoteState('saving');
    try {
      const saved = await saveNote(item.canonicalId, note, noteVersion);
      setNoteVersion(saved.version);
      setNoteState('saved');
      trackActivity(item.canonicalId, 'note_saved');
    } catch { setNoteState('error'); }
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

  return <div className="app-shell">
    <Rail onLibrary={onLibrary} />
    <main className="reading-shell">
      <article className="document">
        <header className="item-header">
          <h1>{item.title}</h1>
          <p className="source-line"><span aria-hidden="true" className="youtube-mark" /> <a href={item.canonicalUrl} target="_blank" rel="noreferrer">youtube.com/watch?v={item.videoId}</a>{item.sourceRefs[0] ? <> · saved from X</> : null}</p>
        </header>

        <div className="player-frame">
          {embedFailed ? <div className="embed-fallback"><p>This video cannot be embedded.</p><a href={item.canonicalUrl} target="_blank" rel="noreferrer">Open on YouTube ↗</a></div>
            : <iframe ref={player} src={youtubeEmbedUrl(item.videoId)} title={item.title} allow="accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture" allowFullScreen onError={() => setEmbedFailed(true)} />}
        </div>
        <p className={`status-line status-${item.status}`} role="status">{statusMessage(item)}</p>

        <section className="source-surface" aria-label="Source navigation">
          <div className="source-controls" aria-hidden="true"><span>↶</span><span className="play-dot">▶</span><span>↷</span><span className="star">☆</span></div>
          <div className="tabs" role="tablist">
            <button role="tab" aria-selected={tab === 'chapters'} onClick={() => setTab('chapters')} disabled={!item.chapters?.length}>Chapters</button>
            <button role="tab" aria-selected={tab === 'transcript'} onClick={() => setTab('transcript')}>Transcript</button>
          </div>
          <div className="source-list" role="tabpanel">
            {tab === 'chapters' ? item.chapters?.map((chapter) => <button className="source-row" key={`${chapter.startMs}-${chapter.label}`} onClick={() => seek(chapter.startMs)}><span>{formatTimestamp(chapter.startMs)}</span><strong>{chapter.label}</strong></button>)
              : transcript.length ? transcript.map((segment) => <button className="source-row transcript-row" key={segment.id} onClick={() => seek(segment.startMs)}><span>{formatTimestamp(segment.startMs)}</span><span>{segment.text}</span></button>)
                : <p className="empty-source">The transcript will appear here as processing completes.</p>}
          </div>
        </section>

        <section className="notes-section">
          <label htmlFor="item-note">Notes</label>
          <textarea id="item-note" value={note} onChange={(event) => { setNote(event.target.value); setNoteState('idle'); }} placeholder="Add notes…" rows={3} />
          <div className="note-actions"><span aria-live="polite">{noteState === 'saving' ? 'Saving…' : noteState === 'saved' ? 'Saved' : noteState === 'error' ? 'Could not save. Reload before retrying.' : ''}</span><button onClick={persistNote} disabled={noteState === 'saving'}>Save note</button></div>
        </section>

        {item.overview?.length ? <section className="synthesis"><h2>Overview</h2><ul>{item.overview.map((claim, index) => <li key={index}>{claim.text} {claim.citations.map((citation) => <TimestampButton key={citation.startMs} milliseconds={citation.startMs} onSeek={seek} />)}</li>)}</ul></section> : null}
        {item.details?.length ? <section className="synthesis"><h2>Details</h2>{item.details.map((claim, index) => <p key={index}>{claim.text} {claim.citations.map((citation) => <TimestampButton key={citation.startMs} milliseconds={citation.startMs} onSeek={seek} />)}</p>)}</section> : null}
        {chat ? <section className={`chat-answer ${chat.refused ? 'chat-refused' : ''}`} aria-live="polite"><p className="eyebrow">Answer</p><p>{chat.answer}</p>{chat.citations.length ? <div className="chat-citations">{chat.citations.map((citation) => <TimestampButton key={citation.segmentId} milliseconds={citation.startMs} onSeek={seek} />)}</div> : null}</section> : null}
      </article>
      <form className="composer" onSubmit={(event) => { event.preventDefault(); void ask(); }}>
        <label className="sr-only" htmlFor="question">Ask about this video</label>
        <input id="question" value={question} onChange={(event) => { setQuestion(event.target.value); setChatState('idle'); }} placeholder={chatState === 'error' ? 'Could not answer. Try again…' : 'Ask anything about this video…'} disabled={item.status !== 'ready' || chatState === 'asking'} maxLength={2000} />
        <span>{item.status === 'ready' ? chatState === 'asking' ? 'Reading transcript…' : 'Grounded in transcript' : 'Available when ready'}</span>
        <button type="submit" disabled={item.status !== 'ready' || chatState === 'asking' || !question.trim()} aria-label="Ask">↑</button>
      </form>
    </main>
  </div>;
}

function EmptyLibrary() {
  return <main className="empty-library"><p className="eyebrow">Your Library</p><h1>Bookmark a YouTube link on X.</h1><p>Field Theory will quietly prepare the transcript, chapters, and a cited reading page here.</p></main>;
}

export default function App() {
  const [items, setItems] = useState<KnowledgeItem[] | null>(null);
  const [selected, setSelected] = useState<KnowledgeItem | null>(null);
  const [transcript, setTranscript] = useState<TranscriptSegment[]>([]);
  const [error, setError] = useState<string | null>(null);

  const loadLibrary = async () => {
    setSelected(null); setTranscript([]); setError(null);
    try {
      const values = await listItems();
      setItems(values);
      if (values[0]) {
        const item = await getItem(values[0].canonicalId);
        setSelected(item);
        setTranscript(await getTranscript(item.canonicalId));
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  useEffect(() => { void loadLibrary(); }, []);

  if (error) return <main className="empty-library"><p className="eyebrow">Field Theory</p><h1>Couldn’t open the library.</h1><p>{error}</p><button onClick={() => void loadLibrary()}>Try again</button></main>;
  if (items === null) return <main className="empty-library" aria-busy="true"><p>Opening your library…</p></main>;
  if (items.length === 0) return <EmptyLibrary />;
  if (!selected) return <main className="empty-library" aria-busy="true"><p>Preparing the page…</p></main>;
  return <ItemPage item={selected} transcript={transcript} onLibrary={() => void loadLibrary()} />;
}
