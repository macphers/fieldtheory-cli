import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { formatTimestamp, ItemPage, youtubeEmbedUrl } from '../web/src/App.js';
import type { KnowledgeItem, TranscriptSegment } from '../web/src/types.js';

const item: KnowledgeItem = {
  canonicalId: 'youtube:dQw4w9WgXcQ', videoId: 'dQw4w9WgXcQ', canonicalUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  title: 'A Redacted Test Conversation', creator: 'Example Channel', durationMs: 180000, language: 'en', status: 'ready',
  sourceRefs: [{ bookmarkId: 'bookmark', bookmarkUrl: 'https://x.com/example/status/1', sourceUrl: 'https://youtu.be/dQw4w9WgXcQ', discoveredAt: '2026-08-12T20:00:00.000Z' }],
  note: { markdown: 'A local note.', version: 1 },
  chapters: [{ startMs: 0, endMs: 60000, label: 'The question' }, { startMs: 60000, endMs: 120000, label: 'The mechanism' }],
  overview: [{ text: 'The conversation starts with a practical question.', citations: [{ startMs: 0, endMs: 60000 }] }],
  details: [{ text: 'The middle explains the mechanism.', citations: [{ startMs: 60000, endMs: 120000 }] }],
};
const transcript: TranscriptSegment[] = [{ id: 'one', startMs: 0, endMs: 60000, text: 'The opening establishes the question.' }];

test('renders the quiet item document with source, navigation, note, synthesis, and grounded composer', () => {
  const html = renderToStaticMarkup(createElement(ItemPage, { item, transcript, onLibrary: () => {} }));
  assert.match(html, /A Redacted Test Conversation/);
  assert.match(html, /youtube\.com\/watch\?v=dQw4w9WgXcQ/);
  assert.match(html, /Chapters/);
  assert.match(html, /Transcript/);
  assert.match(html, /A local note\./);
  assert.match(html, /Overview/);
  assert.match(html, /Details/);
  assert.match(html, /Ask anything about this video/);
  assert.match(html, /Grounded in transcript/);
});

test('formats timestamps and YouTube embeds deterministically', () => {
  assert.equal(formatTimestamp(0), '0:00');
  assert.equal(formatTimestamp(65000), '1:05');
  assert.equal(formatTimestamp(3_661_000), '1:01:01');
  assert.equal(youtubeEmbedUrl('dQw4w9WgXcQ'), 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?enablejsapi=1&rel=0');
});

test('progressive item states keep source content visible while work is incomplete', () => {
  const processing = { ...item, status: 'processing' as const, overview: undefined, details: undefined, chapters: undefined, jobs: [{ id: 'job', stage: 'transcript', state: 'running' }] };
  const html = renderToStaticMarkup(createElement(ItemPage, { item: processing, transcript: [], onLibrary: () => {} }));
  assert.match(html, /Preparing transcript/);
  assert.match(html, /The transcript will appear here/);
  assert.match(html, /Available when ready/);
  assert.match(html, /disabled=""/);
});
