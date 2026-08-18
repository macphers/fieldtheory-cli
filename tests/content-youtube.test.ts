import test from 'node:test';
import assert from 'node:assert/strict';
import type { BookmarkRecord } from '../src/types.js';
import { discoverArticleContent, discoverPodcastContent, discoverYouTubeContent, normalizePodcastUrl } from '../src/content/discovery.js';
import { extractUrls, normalizeYouTubeUrl } from '../src/content/youtube.js';

const VIDEO_ID = 'dQw4w9WgXcQ';

test('normalizes supported YouTube URL shapes to one canonical identity', () => {
  const variants = [
    `https://www.youtube.com/watch?v=${VIDEO_ID}&t=90`,
    `https://m.youtube.com/watch?v=${VIDEO_ID}`,
    `https://youtu.be/${VIDEO_ID}?si=test`,
    `https://youtube.com/shorts/${VIDEO_ID}`,
    `https://www.youtube.com/embed/${VIDEO_ID}`,
    `https://youtube.com/live/${VIDEO_ID}`,
  ];

  for (const variant of variants) {
    assert.deepEqual(normalizeYouTubeUrl(variant), {
      videoId: VIDEO_ID,
      canonicalId: `youtube:${VIDEO_ID}`,
      canonicalUrl: `https://www.youtube.com/watch?v=${VIDEO_ID}`,
    });
  }
});

test('rejects unsupported hosts, malformed IDs, and channel pages', () => {
  assert.equal(normalizeYouTubeUrl('https://example.com/watch?v=dQw4w9WgXcQ'), null);
  assert.equal(normalizeYouTubeUrl('https://youtube.com/watch?v=short'), null);
  assert.equal(normalizeYouTubeUrl('https://youtube.com/@example'), null);
  assert.equal(normalizeYouTubeUrl('not a url'), null);
});

test('extractUrls trims sentence punctuation without damaging query strings', () => {
  assert.deepEqual(
    extractUrls(`Watch https://youtu.be/${VIDEO_ID}?t=42, then discuss.`),
    [`https://youtu.be/${VIDEO_ID}?t=42`],
  );
});

test('discovers links in bookmark and quoted-post fields and deduplicates by video', () => {
  const bookmarks: BookmarkRecord[] = [
    {
      id: 'one', tweetId: 'one', url: 'https://x.com/a/status/1', text: `Watch https://youtu.be/${VIDEO_ID}`,
      links: [`https://youtube.com/watch?v=${VIDEO_ID}`], syncedAt: '2026-08-01T00:00:00.000Z',
    },
    {
      id: 'two', tweetId: 'two', url: 'https://x.com/b/status/2', text: 'Quoted below',
      syncedAt: '2026-08-02T00:00:00.000Z', quotedTweet: {
        id: 'quoted', text: `Original https://youtube.com/shorts/${VIDEO_ID}`,
        url: 'https://x.com/c/status/3',
      },
    },
  ];

  const items = discoverYouTubeContent(bookmarks);
  assert.equal(items.length, 1);
  assert.equal(items[0].canonicalId, `youtube:${VIDEO_ID}`);
  assert.deepEqual(items[0].sourceRefs.map((ref) => ref.bookmarkId), ['one', 'two']);
});

test('discovers bookmark and quoted media surfaces with deterministic provenance ordering', () => {
  const bookmarks: BookmarkRecord[] = [
    {
      id: 'later', tweetId: 'later', url: 'https://x.com/a/status/4', text: '',
      media: ['https://youtu.be/ccccccccccc'],
      mediaObjects: [{ expandedUrl: 'https://youtube.com/watch?v=aaaaaaaaaaa' }],
      syncedAt: '2026-08-03T00:00:00.000Z', bookmarkedAt: '2026-08-02T00:00:00.000Z',
      quotedTweet: {
        id: 'quoted', text: '', url: 'https://x.com/b/status/5',
        media: ['https://youtube.com/shorts/ddddddddddd'],
        mediaObjects: [{ mediaUrl: 'https://youtube.com/embed/bbbbbbbbbbb' }],
      },
    },
    {
      id: 'earlier', tweetId: 'earlier', url: 'https://x.com/c/status/6', text: '',
      links: ['https://youtube.com/watch?v=aaaaaaaaaaa'],
      syncedAt: '2026-08-01T00:00:00.000Z',
    },
  ];

  const items = discoverYouTubeContent(bookmarks);
  assert.deepEqual(items.map((item) => item.videoId), ['aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc', 'ddddddddddd']);
  assert.deepEqual(items[0].sourceRefs.map((ref) => ref.bookmarkId), ['earlier', 'later']);
  assert.deepEqual(items[0].sourceRefs.map((ref) => ref.discoveredAt), [
    '2026-08-01T00:00:00.000Z',
    '2026-08-02T00:00:00.000Z',
  ]);
});

test('discovers enriched X articles as private source documents', () => {
  const [article] = discoverArticleContent([{
    id: 'article-1', tweetId: 'article-1', url: 'https://x.com/example/article/1', text: 'Preview', syncedAt: '2026-08-01T00:00:00.000Z',
    authorName: 'Example Author', language: 'en', articleTitle: 'A Durable Idea', articleText: 'First paragraph.\n\nSecond paragraph.', articleSite: 'X',
  }]);
  assert.equal(article.canonicalId, 'article:x:article-1');
  assert.equal(article.type, 'article');
  assert.equal(article.sourceTitle, 'A Durable Idea');
  assert.equal(article.sourceText, 'First paragraph.\n\nSecond paragraph.');
  assert.equal(article.sourceRefs[0].bookmarkId, 'article-1');
});

test('discovers supported podcast episode pages without treating Spotify tracks as podcasts', () => {
  const episode = 'https://serve.podhome.fm/episodepage/CitadelDispatch/cd207-example?utm_source=x';
  const normalized = normalizePodcastUrl(episode);
  assert.equal(normalized?.canonicalUrl, 'https://serve.podhome.fm/episodepage/CitadelDispatch/cd207-example');
  assert.match(normalized?.canonicalId ?? '', /^podcast:[a-f0-9]{24}$/);
  assert.equal(normalizePodcastUrl('https://open.spotify.com/track/example'), null);
  const [item] = discoverPodcastContent([{
    id: 'podcast-1', tweetId: 'podcast-1', url: 'https://x.com/example/status/1', text: `Listen: ${episode}`, links: [episode], syncedAt: '2026-08-01T00:00:00.000Z',
  }]);
  assert.equal(item.type, 'podcast');
  assert.equal(item.sourceRefs.length, 1);
});
