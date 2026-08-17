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

export function discoverYouTubeContent(bookmarks: BookmarkRecord[]): DiscoveredContentItem[] {
  const items = new Map<string, DiscoveredContentItem>();

  for (const bookmark of bookmarks) {
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
