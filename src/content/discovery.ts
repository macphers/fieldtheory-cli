import { createHash } from 'node:crypto';
import type { BookmarkMediaObject, BookmarkRecord } from '../types.js';
import type { DiscoveredContentItem } from './types.js';
import { extractUrls, normalizeYouTubeUrl } from './youtube.js';

function mediaUrls(media: BookmarkMediaObject[] | undefined): string[] {
  if (!media) return [];
  return media.flatMap((item) => [item.expandedUrl, item.url, item.mediaUrl].filter((url): url is string => Boolean(url)));
}

function candidateUrls(bookmark: BookmarkRecord): string[] {
  return [
    ...(bookmark.links ?? []),
    ...extractUrls(bookmark.text),
    ...(bookmark.media ?? []),
    ...mediaUrls(bookmark.mediaObjects),
    ...extractUrls(bookmark.quotedTweet?.text),
    ...(bookmark.quotedTweet?.media ?? []),
    ...mediaUrls(bookmark.quotedTweet?.mediaObjects),
  ];
}

/** Legacy like-timeline imports share the cache format but are not bookmarks. */
export function isUserSavedBookmark(bookmark: BookmarkRecord): boolean {
  return !(bookmark.tags ?? []).some((tag) => tag.toLowerCase() === 'twitter-like');
}

const PODCAST_EPISODE_PATTERNS: Array<[string, RegExp]> = [
  ['serve.podhome.fm', /^\/episodepage\//],
  ['buzzsprout.com', /\/episodes?\//],
  ['simplecast.com', /^\/s\//],
  ['podbean.com', /\/(?:e|ew)\//],
  ['transistor.fm', /^\/s\//],
  ['redcircle.com', /^\/shows\/[^/]+\/episodes\//],
  ['rss.com', /^\/podcasts\/[^/]+\/\d+/],
  ['audioboom.com', /^\/posts\/\d+/],
];

export function normalizePodcastUrl(value: string): { canonicalId: `podcast:${string}`; canonicalUrl: string } | null {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    const supported = PODCAST_EPISODE_PATTERNS.some(([domain, pattern]) => (host === domain || host.endsWith(`.${domain}`)) && pattern.test(url.pathname));
    if (!supported) return null;
    for (const key of [...url.searchParams.keys()]) if (/^(?:utm_|si$|ref$)/i.test(key)) url.searchParams.delete(key);
    url.hash = '';
    const canonicalUrl = url.toString();
    const id = createHash('sha256').update(canonicalUrl).digest('hex').slice(0, 24);
    return { canonicalId: `podcast:${id}`, canonicalUrl };
  } catch { return null; }
}

export function discoverYouTubeContent(bookmarks: BookmarkRecord[]): DiscoveredContentItem[] {
  const items = new Map<string, DiscoveredContentItem>();

  for (const bookmark of bookmarks) {
    if (!isUserSavedBookmark(bookmark)) continue;
    const seenForBookmark = new Set<string>();
    for (const sourceUrl of candidateUrls(bookmark)) {
      const source = normalizeYouTubeUrl(sourceUrl);
      if (!source || seenForBookmark.has(source.canonicalId)) continue;
      seenForBookmark.add(source.canonicalId);

      const existing = items.get(source.canonicalId) ?? {
        ...source,
        type: 'youtube' as const,
        sourceRefs: [],
      };
      existing.sourceRefs.push({
        bookmarkId: bookmark.id,
        bookmarkUrl: bookmark.url,
        discoveredAt: bookmark.bookmarkedAt ?? bookmark.syncedAt,
        sourceUrl,
      });
      items.set(source.canonicalId, existing);
    }
  }

  return Array.from(items.values())
    .map((item) => ({
      ...item,
      sourceRefs: item.sourceRefs.sort((a, b) =>
        a.discoveredAt.localeCompare(b.discoveredAt) || a.bookmarkId.localeCompare(b.bookmarkId)),
    }))
    .sort((a, b) => a.canonicalId.localeCompare(b.canonicalId));
}

export function discoverArticleContent(bookmarks: BookmarkRecord[]): DiscoveredContentItem[] {
  const items = new Map<string, DiscoveredContentItem>();
  for (const bookmark of bookmarks) {
    if (!isUserSavedBookmark(bookmark)) continue;
    const sourceText = bookmark.articleText?.trim();
    if (!sourceText) continue;
    const externalUrl = (bookmark.links ?? []).flatMap((value) => {
      try {
        const url = new URL(value);
        const host = url.hostname.toLowerCase().replace(/^www\./, '');
        if (['x.com', 'twitter.com'].includes(host) || host.endsWith('.x.com') || host.endsWith('.twitter.com') || normalizeYouTubeUrl(value) || normalizePodcastUrl(value)) return [];
        url.hash = '';
        for (const key of [...url.searchParams.keys()]) if (/^(?:utm_|ref$)/i.test(key)) url.searchParams.delete(key);
        return [url.toString()];
      } catch { return []; }
    })[0];
    const canonicalUrl = externalUrl ?? bookmark.url;
    const canonicalId = externalUrl
      ? `article:web:${createHash('sha256').update(canonicalUrl).digest('hex').slice(0, 24)}` as const
      : `article:x:${bookmark.id}` as const;
    const existing = items.get(canonicalId) ?? {
      canonicalId,
      canonicalUrl,
      type: 'article' as const,
      sourceText,
      sourceTitle: bookmark.articleTitle?.trim() || bookmark.text.trim().slice(0, 120) || (externalUrl ? 'Saved article' : 'Saved X article'),
      sourceCreator: externalUrl
        ? bookmark.articleSite?.trim() || bookmark.authorName?.trim() || bookmark.authorHandle?.trim() || 'Unknown publisher'
        : bookmark.authorName?.trim() || bookmark.authorHandle?.trim() || bookmark.articleSite?.trim() || 'Unknown author',
      sourceLanguage: bookmark.language?.trim() || 'en',
      sourceRefs: [],
    };
    existing.sourceRefs.push({ bookmarkId: bookmark.id, bookmarkUrl: bookmark.url, discoveredAt: bookmark.bookmarkedAt ?? bookmark.syncedAt, sourceUrl: canonicalUrl });
    items.set(canonicalId, existing);
  }
  return Array.from(items.values()).map((item) => ({
    ...item,
    sourceRefs: item.sourceRefs.sort((a, b) => a.discoveredAt.localeCompare(b.discoveredAt) || a.bookmarkId.localeCompare(b.bookmarkId)),
  })).sort((left, right) => left.canonicalId.localeCompare(right.canonicalId));
}

export function discoverPodcastContent(bookmarks: BookmarkRecord[]): DiscoveredContentItem[] {
  const items = new Map<string, DiscoveredContentItem>();
  for (const bookmark of bookmarks) {
    if (!isUserSavedBookmark(bookmark)) continue;
    const seenForBookmark = new Set<string>();
    for (const sourceUrl of candidateUrls(bookmark)) {
      const source = normalizePodcastUrl(sourceUrl);
      if (!source || seenForBookmark.has(source.canonicalId)) continue;
      seenForBookmark.add(source.canonicalId);
      const existing = items.get(source.canonicalId) ?? { ...source, type: 'podcast' as const, sourceRefs: [] };
      existing.sourceRefs.push({ bookmarkId: bookmark.id, bookmarkUrl: bookmark.url, discoveredAt: bookmark.bookmarkedAt ?? bookmark.syncedAt, sourceUrl });
      items.set(source.canonicalId, existing);
    }
  }
  return Array.from(items.values()).map((item) => ({
    ...item,
    sourceRefs: item.sourceRefs.sort((a, b) => a.discoveredAt.localeCompare(b.discoveredAt) || a.bookmarkId.localeCompare(b.bookmarkId)),
  })).sort((left, right) => left.canonicalId.localeCompare(right.canonicalId));
}

export function discoverKnowledgeContent(bookmarks: BookmarkRecord[]): DiscoveredContentItem[] {
  return [...discoverYouTubeContent(bookmarks), ...discoverArticleContent(bookmarks), ...discoverPodcastContent(bookmarks)]
    .sort((left, right) => left.canonicalId.localeCompare(right.canonicalId));
}
