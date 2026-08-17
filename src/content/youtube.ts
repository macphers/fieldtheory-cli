import type { YouTubeSource } from './types.js';

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const URL_PATTERN = /https?:\/\/[^\s<>"')\]]+/gi;

function cleanCandidate(value: string): string {
  return value.trim().replace(/[.,!?;:]+$/, '');
}

function videoIdFromUrl(url: URL): string | null {
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  if (host === 'youtu.be') return url.pathname.split('/').filter(Boolean)[0] ?? null;

  const youtubeHosts = new Set([
    'youtube.com',
    'm.youtube.com',
    'music.youtube.com',
    'youtube-nocookie.com',
  ]);
  if (!youtubeHosts.has(host)) return null;

  if (url.pathname === '/watch') return url.searchParams.get('v');
  const [kind, id] = url.pathname.split('/').filter(Boolean);
  if (kind === 'shorts' || kind === 'embed' || kind === 'live') return id ?? null;
  return null;
}

export function normalizeYouTubeUrl(value: string): YouTubeSource | null {
  let url: URL;
  try {
    url = new URL(cleanCandidate(value));
  } catch {
    return null;
  }

  const videoId = videoIdFromUrl(url);
  if (!videoId || !VIDEO_ID.test(videoId)) return null;
  return {
    videoId,
    canonicalId: `youtube:${videoId}`,
    canonicalUrl: `https://www.youtube.com/watch?v=${videoId}`,
  };
}

export function extractUrls(text: string | undefined): string[] {
  if (!text) return [];
  return Array.from(text.matchAll(URL_PATTERN), (match) => cleanCandidate(match[0]));
}
