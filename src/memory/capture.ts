import { createHash, randomUUID } from 'node:crypto';
import { normalizeYouTubeUrl } from '../content/youtube.js';
import { normalizePodcastUrl } from '../content/discovery.js';
import { articleSource } from '../content/orchestrator.js';
import type { ContentRepository, StoredContentItem } from '../content/repository.js';
import { jobInputFingerprint } from '../jobs/state-machine.js';
import { fetchReadableArticle } from './article.js';

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export async function captureManualUrl(repository: ContentRepository, input: string, now = new Date()): Promise<{ itemId: string; kind: string }> {
  const url = new URL(input);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('unsafe_capture_url');
  const timestamp = now.toISOString();
  const youtube = normalizeYouTubeUrl(url.toString());
  const podcast = normalizePodcastUrl(url.toString());
  if (youtube || podcast) {
    const source = youtube ?? podcast!;
    const item: StoredContentItem = {
      ...source,
      type: youtube ? 'youtube' : 'podcast',
      ...(youtube ? { videoId: youtube.videoId } : {}),
      sourceRefs: [{ bookmarkId: `manual:${randomUUID()}`, bookmarkUrl: source.canonicalUrl, sourceUrl: source.canonicalUrl, discoveredAt: timestamp }],
      title: 'Preparing knowledge page…',
      creator: 'Unknown creator',
      durationMs: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await repository.upsertItem(item);
    await repository.enqueueJob(item.canonicalId, 'metadata', jobInputFingerprint(item.canonicalId, 'metadata', [hash(item.canonicalUrl)], 1), 1, timestamp, { priority: 100, resourceClass: 'network' });
    return { itemId: item.canonicalId, kind: item.type };
  }
  const article = await fetchReadableArticle(url.toString());
  const canonicalId = `article:web:${createHash('sha256').update(article.canonicalUrl).digest('hex').slice(0, 24)}` as const;
  const source = articleSource(article.text, 'en');
  const item: StoredContentItem = {
    canonicalId,
    canonicalUrl: article.canonicalUrl,
    type: 'article',
    sourceRefs: [{ bookmarkId: `manual:${randomUUID()}`, bookmarkUrl: article.canonicalUrl, sourceUrl: article.canonicalUrl, discoveredAt: timestamp }],
    title: article.title,
    creator: article.creator,
    durationMs: source.durationMs,
    creatorChapters: source.chapters,
    language: 'en',
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  await repository.upsertItem(item);
  await repository.saveTranscript({ itemId: canonicalId, artifactHash: source.transcript.contentHash, artifactPath: `inline:manual-article:${canonicalId}`, transcript: source.transcript, acquiredAt: timestamp });
  await repository.enqueueJob(canonicalId, 'chapters', jobInputFingerprint(canonicalId, 'chapters', [source.transcript.contentHash, hash(source.chapters)], 1), 1, timestamp, { priority: 100, resourceClass: 'model' });
  return { itemId: canonicalId, kind: 'article' };
}
