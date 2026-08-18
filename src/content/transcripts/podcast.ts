import { open, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { ensureDir } from '../../fs.js';
import { isSafeUrl } from '../../bookmark-enrich.js';
import { normalizeTranscript } from '../knowledge-page.js';
import type { ProcessRunner } from '../process-runner.js';
import { ProcessExecutionError } from '../process-runner.js';
import type { RawChapter, RawTranscriptSegment, TranscriptArtifact } from '../types.js';
import { persistTranscriptArtifact } from './artifact-store.js';
import { assessTranscriptQuality, TranscriptAcquisitionError } from './yt-dlp.js';
import { WhisperCppTranscriptProvider } from './whisper-cpp.js';

const MAX_TEXT_BYTES = 20 * 1024 * 1024;
const MAX_AUDIO_BYTES = 1024 * 1024 * 1024;
const MAX_REDIRECTS = 5;

export interface PodcastEpisodeMetadata {
  title: string;
  creator: string;
  durationMs: number;
  mediaUrl: string;
  thumbnailUrl?: string;
  language?: string;
  creatorChapters?: RawChapter[];
  transcriptUrl?: string;
  transcriptType?: string;
}

export interface PodcastAcquisition {
  media: PodcastEpisodeMetadata;
  transcript: TranscriptArtifact;
  artifactPath: string;
  source: 'publisher-transcript' | 'local-transcription';
}

interface PodcastTranscriptOptions {
  runner: ProcessRunner;
  whisperProvider: WhisperCppTranscriptProvider;
  contentRoot: string;
  tempRoot: string;
  fetch?: typeof globalThis.fetch;
  ffmpegBinary?: string;
  maxLocalDurationMs?: number;
}

function decodeMarkup(value: string): string {
  const stripped = value.replace(/^\s*<!\[CDATA\[|\]\]>\s*$/g, '').trim();
  return stripped.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (entity, code: string) => {
    if (code[0] === '#') {
      const numeric = code[1].toLowerCase() === 'x' ? Number.parseInt(code.slice(2), 16) : Number.parseInt(code.slice(1), 10);
      return Number.isFinite(numeric) ? String.fromCodePoint(numeric) : entity;
    }
    return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[code.toLowerCase()] ?? entity;
  });
}

function attributes(tag: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const match of tag.matchAll(/([:\w-]+)\s*=\s*(["'])(.*?)\2/g)) values[match[1].toLowerCase()] = decodeMarkup(match[3]);
  return values;
}

function tags(value: string, name: string): string[] {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return Array.from(value.matchAll(new RegExp(`<${escaped}\\b[^>]*>[\\s\\S]*?<\\/${escaped}>`, 'gi')), (match) => match[0]);
}

function tagText(value: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = value.match(new RegExp(`<${escaped}\\b[^>]*>([\\s\\S]*?)<\\/${escaped}>`, 'i'));
  return match ? decodeMarkup(match[1]) : undefined;
}

function firstTag(value: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return value.match(new RegExp(`<${escaped}\\b[^>]*\/?>`, 'i'))?.[0];
}

function safeExternalUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return !url.username && !url.password && isSafeUrl(value);
  } catch { return false; }
}

function absoluteUrl(value: string | undefined, base: string): string | undefined {
  if (!value) return undefined;
  try {
    const resolved = new URL(value, base).toString();
    return safeExternalUrl(resolved) ? resolved : undefined;
  } catch { return undefined; }
}

function normalizedUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch { return value.replace(/\/$/, ''); }
}

function durationMs(value: string | undefined): number {
  if (!value) return 0;
  if (/^\d+(?:\.\d+)?$/.test(value.trim())) return Math.round(Number(value) * 1000);
  const parts = value.trim().split(':').map(Number);
  if (parts.some((part) => !Number.isFinite(part))) return 0;
  let seconds = 0;
  for (const part of parts) seconds = seconds * 60 + part;
  return Math.round(seconds * 1000);
}

function parseTimestamp(value: string): number {
  const parts = value.replace(',', '.').split(':').map(Number);
  if (parts.some((part) => !Number.isFinite(part))) return Number.NaN;
  const [hours, minutes, seconds] = parts.length === 3 ? parts : [0, parts[0], parts[1]];
  return Math.round(((hours * 60 + minutes) * 60 + seconds) * 1000);
}

function parseTimedText(value: string): RawTranscriptSegment[] {
  const lines = value.replace(/^\uFEFF/, '').replace(/\r/g, '').split('\n');
  const segments: RawTranscriptSegment[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].includes('-->')) continue;
    const [from, rawTo] = lines[index].split(/\s+-->\s+/);
    const to = rawTo?.split(/\s+/)[0];
    const text: string[] = [];
    while (++index < lines.length && lines[index].trim()) text.push(lines[index].replace(/<[^>]+>/g, '').trim());
    const startMs = parseTimestamp(from.trim());
    const endMs = parseTimestamp(to?.trim() ?? '');
    const normalized = decodeMarkup(text.join(' ').replace(/\s+/g, ' ').trim());
    if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs && normalized) segments.push({ startMs, endMs, text: normalized });
  }
  return segments;
}

export class PodcastTranscriptPipeline {
  private readonly fetcher: typeof globalThis.fetch;

  constructor(private readonly options: PodcastTranscriptOptions) {
    this.fetcher = options.fetch ?? globalThis.fetch;
  }

  private async response(url: string, signal?: AbortSignal): Promise<{ response: Response; finalUrl: string }> {
    let current = url;
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
      if (!safeExternalUrl(current)) throw new TranscriptAcquisitionError('invalid_output', 'The podcast feed returned an unsafe URL.', false, 'Open the source directly to verify its feed configuration.');
      let response: Response;
      try {
        const fetchSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000);
        response = await this.fetcher(current, { redirect: 'manual', signal: fetchSignal, headers: { 'User-Agent': 'FieldTheory/1.0', Accept: '*/*' } });
      } catch (error) {
        if (signal?.aborted) throw error;
        throw new TranscriptAcquisitionError('network', 'The podcast source could not be downloaded.', true, 'Check the network connection and retry.');
      }
      if (response.status < 300 || response.status >= 400 || response.status === 304) return { response, finalUrl: current };
      const location = response.headers.get('location');
      await response.body?.cancel().catch(() => undefined);
      if (!location || redirects === MAX_REDIRECTS) throw new TranscriptAcquisitionError('invalid_output', 'The podcast source exceeded the redirect limit.', false, 'Open the source directly to verify its feed configuration.');
      current = new URL(location, current).toString();
    }
    throw new TranscriptAcquisitionError('invalid_output', 'The podcast source exceeded the redirect limit.', false, 'Open the source directly to verify its feed configuration.');
  }

  private async text(url: string, signal?: AbortSignal): Promise<{ text: string; finalUrl: string }> {
    const result = await this.response(url, signal);
    if (!result.response.ok) throw new TranscriptAcquisitionError('network', `Podcast source download failed with HTTP ${result.response.status}.`, result.response.status >= 500, 'Open the source directly or retry later.');
    const declared = Number(result.response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_TEXT_BYTES) throw new TranscriptAcquisitionError('invalid_output', 'The podcast metadata or transcript exceeds the 20 MB safety limit.', false, 'Open the source directly.');
    const reader = result.response.body?.getReader();
    if (!reader) return { text: '', finalUrl: result.finalUrl };
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_TEXT_BYTES) { await reader.cancel().catch(() => undefined); throw new TranscriptAcquisitionError('invalid_output', 'The podcast metadata or transcript exceeds the 20 MB safety limit.', false, 'Open the source directly.'); }
      chunks.push(value);
    }
    return { text: new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))), finalUrl: result.finalUrl };
  }

  private async chapters(url: string | undefined, episodeDurationMs: number, signal?: AbortSignal): Promise<RawChapter[] | undefined> {
    if (!url) return undefined;
    try {
      const parsed = JSON.parse((await this.text(url, signal)).text) as { chapters?: Array<{ startTime?: number; endTime?: number; title?: string }> };
      const candidates = (parsed.chapters ?? []).filter((chapter) => Number.isFinite(chapter.startTime) && chapter.title?.trim()).sort((a, b) => a.startTime! - b.startTime!);
      const result = candidates.flatMap((chapter, index) => {
        const startMs = Math.round(chapter.startTime! * 1000);
        const endMs = Number.isFinite(chapter.endTime) ? Math.round(chapter.endTime! * 1000) : index + 1 < candidates.length ? Math.round(candidates[index + 1].startTime! * 1000) : episodeDurationMs;
        return endMs > startMs ? [{ startMs, endMs, label: chapter.title!.trim(), source: 'creator' as const }] : [];
      });
      return result.length ? result : undefined;
    } catch (error) {
      if (signal?.aborted) throw error;
      return undefined;
    }
  }

  private async resolve(url: string, signal?: AbortSignal): Promise<PodcastEpisodeMetadata> {
    const page = await this.text(url, signal);
    const linkTags = Array.from(page.text.matchAll(/<link\b[^>]*>/gi), (match) => match[0]);
    const rssTag = linkTags.find((tag) => {
      const attrs = attributes(tag);
      return attrs.rel?.toLowerCase().split(/\s+/).includes('alternate') && /(?:application\/rss\+xml|application\/atom\+xml)/i.test(attrs.type ?? '');
    });
    const rssUrl = absoluteUrl(rssTag ? attributes(rssTag).href : undefined, page.finalUrl);
    if (!rssUrl) throw new TranscriptAcquisitionError('invalid_output', 'This podcast page does not advertise an RSS feed.', false, 'Open the episode source and use a feed-backed episode page.');
    const feed = await this.text(rssUrl, signal);
    const pageTitleTag = page.text.match(/<meta\b[^>]*(?:property|name)=["'](?:og:title|twitter:title)["'][^>]*>/i)?.[0]
      ?? page.text.match(/<meta\b[^>]*content=["'][^"']+["'][^>]*(?:property|name)=["'](?:og:title|twitter:title)["'][^>]*>/i)?.[0];
    const pageTitle = pageTitleTag ? attributes(pageTitleTag).content : undefined;
    const item = tags(feed.text, 'item').find((candidate) => {
      const link = tagText(candidate, 'link');
      return Boolean(link && normalizedUrl(link) === normalizedUrl(page.finalUrl));
    }) ?? tags(feed.text, 'item').find((candidate) => pageTitle && tagText(candidate, 'title') === pageTitle);
    if (!item) throw new TranscriptAcquisitionError('unavailable', 'The episode was not found in its advertised RSS feed.', false, 'Open the episode source and verify that it is still published.');
    const enclosureTag = firstTag(item, 'enclosure');
    const enclosure = enclosureTag ? attributes(enclosureTag) : {};
    const mediaUrl = absoluteUrl(enclosure.url, feed.finalUrl);
    const title = tagText(item, 'itunes:title') ?? tagText(item, 'title');
    const duration = durationMs(tagText(item, 'itunes:duration'));
    if (!mediaUrl || !title || duration <= 0) throw new TranscriptAcquisitionError('invalid_output', 'Podcast feed metadata is missing the episode title, duration, or audio enclosure.', true, 'Refresh the feed and retry.');
    const channel = feed.text.match(/<channel\b[^>]*>([\s\S]*?)<\/channel>/i)?.[1] ?? feed.text;
    const imageTag = firstTag(item, 'itunes:image') ?? firstTag(channel, 'itunes:image');
    const transcriptTags = Array.from(item.matchAll(/<podcast:transcript\b[^>]*\/?>/gi), (match) => attributes(match[0]));
    const transcript = transcriptTags.find((entry) => /(?:text\/vtt|application\/x-subrip)/i.test(entry.type ?? ''));
    const chapterTag = firstTag(item, 'podcast:chapters');
    const chapterUrl = absoluteUrl(chapterTag ? attributes(chapterTag).url : undefined, feed.finalUrl);
    const language = transcript?.language ?? tagText(item, 'dc:language') ?? tagText(channel, 'language') ?? 'en';
    const creatorChapters = await this.chapters(chapterUrl, duration, signal);
    return {
      title,
      creator: tagText(item, 'itunes:author') ?? tagText(channel, 'itunes:author') ?? tagText(channel, 'title') ?? 'Unknown creator',
      durationMs: duration,
      mediaUrl,
      language,
      ...(imageTag && absoluteUrl(attributes(imageTag).href, feed.finalUrl) ? { thumbnailUrl: absoluteUrl(attributes(imageTag).href, feed.finalUrl) } : {}),
      ...(creatorChapters ? { creatorChapters } : {}),
      ...(transcript?.url && absoluteUrl(transcript.url, feed.finalUrl) ? { transcriptUrl: absoluteUrl(transcript.url, feed.finalUrl), transcriptType: transcript.type } : {}),
    };
  }

  async acquireMetadata(url: string, signal?: AbortSignal): Promise<PodcastEpisodeMetadata> {
    return this.resolve(url, signal);
  }

  private async download(url: string, destination: string, signal?: AbortSignal): Promise<void> {
    const result = await this.response(url, signal);
    if (!result.response.ok) throw new TranscriptAcquisitionError('network', `Podcast audio download failed with HTTP ${result.response.status}.`, result.response.status >= 500, 'Retry the episode later.');
    const declared = Number(result.response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_AUDIO_BYTES) throw new TranscriptAcquisitionError('invalid_output', 'The podcast audio exceeds the 1 GB safety limit.', false, 'Open the source directly.');
    const reader = result.response.body?.getReader();
    if (!reader) throw new TranscriptAcquisitionError('network', 'The podcast audio response was empty.', true, 'Retry the episode later.');
    const file = await open(destination, 'wx', 0o600);
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_AUDIO_BYTES) { await reader.cancel().catch(() => undefined); throw new TranscriptAcquisitionError('invalid_output', 'The podcast audio exceeds the 1 GB safety limit.', false, 'Open the source directly.'); }
        await file.write(value);
      }
    } finally { await file.close(); }
  }

  async acquire(url: string, requestedLanguage?: string, signal?: AbortSignal, allowLongTranscription = false): Promise<PodcastAcquisition> {
    const media = await this.resolve(url, signal);
    if (media.transcriptUrl) {
      try {
        const raw = (await this.text(media.transcriptUrl, signal)).text;
        const segments = parseTimedText(raw);
        if (assessTranscriptQuality(segments, media.durationMs).length === 0) {
          const transcript = normalizeTranscript(requestedLanguage ?? media.language ?? 'en', { provider: 'podcast-rss', source: 'publisher-transcript' }, segments);
          const artifactPath = await persistTranscriptArtifact(this.options.contentRoot, transcript);
          return { media, transcript, artifactPath, source: 'publisher-transcript' };
        }
      } catch (error) {
        if (signal?.aborted) throw error;
      }
    }
    const maximum = this.options.maxLocalDurationMs ?? 2 * 60 * 60_000;
    if (!allowLongTranscription && media.durationMs > maximum) throw new TranscriptAcquisitionError('captions_unavailable', `Local transcription is limited to ${Math.round(maximum / 60_000)} minutes for this item.`, false, 'Use the explicit per-item long-transcription override to continue.');
    await ensureDir(this.options.tempRoot);
    const workDir = await mkdtemp(path.join(this.options.tempRoot, 'podcast-'));
    const sourcePath = path.join(workDir, 'source-audio');
    const audioPath = path.join(workDir, 'audio.wav');
    const outputPrefix = path.join(workDir, 'transcript');
    try {
      await this.download(media.mediaUrl, sourcePath, signal);
      try {
        await this.options.runner.run({ command: this.options.ffmpegBinary ?? 'ffmpeg', args: ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', sourcePath, '-ar', '16000', '-ac', '1', audioPath], timeoutMs: 15 * 60_000, maxOutputBytes: 2 * 1024 * 1024, signal });
      } catch (error) {
        if (error instanceof ProcessExecutionError && error.reason === 'aborted') throw error;
        if (error instanceof ProcessExecutionError && (error.reason === 'spawn' || /ffmpeg.*(?:not found|not installed)/i.test(`${error.result.stderr}\n${error.result.stdout}`))) throw new TranscriptAcquisitionError('ffmpeg_missing', 'ffmpeg is not installed or is not executable.', false, 'Run `ft app doctor` for installation instructions.');
        throw new TranscriptAcquisitionError('invalid_output', 'The podcast audio could not be converted for local transcription.', true, 'Retry the episode or open the source directly.');
      }
      const transcript = await this.options.whisperProvider.transcribe(audioPath, outputPrefix, media.durationMs, signal);
      const artifactPath = await persistTranscriptArtifact(this.options.contentRoot, transcript);
      return { media, transcript, artifactPath, source: 'local-transcription' };
    } finally { await rm(workDir, { recursive: true, force: true }); }
  }
}
