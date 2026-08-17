import { normalizeTranscript } from '../knowledge-page.js';
import type { RawTranscriptSegment, TranscriptArtifact } from '../types.js';
import type { ProcessRunner } from '../process-runner.js';
import { ProcessExecutionError } from '../process-runner.js';

interface CaptionFormat {
  ext?: string;
  url?: string;
  name?: string;
}

interface YtDlpMetadata {
  id: string;
  title?: string;
  channel?: string;
  uploader?: string;
  duration?: number;
  thumbnail?: string;
  language?: string;
  subtitles?: Record<string, CaptionFormat[]>;
  automatic_captions?: Record<string, CaptionFormat[]>;
  chapters?: Array<{ start_time?: number; end_time?: number; title?: string }>;
}

export interface YtDlpMediaMetadata {
  videoId: string;
  title: string;
  creator: string;
  durationMs: number;
  thumbnailUrl?: string;
  language?: string;
  creatorChapters?: Array<{ startMs: number; endMs: number; label: string; source: 'creator' }>;
}

function metadataChapters(metadata: YtDlpMetadata): YtDlpMediaMetadata['creatorChapters'] {
  const chapters = (metadata.chapters ?? []).flatMap((chapter) => {
    if (!Number.isFinite(chapter.start_time) || !Number.isFinite(chapter.end_time) || chapter.end_time! <= chapter.start_time! || !chapter.title?.trim()) return [];
    return [{ startMs: Math.round(chapter.start_time! * 1000), endMs: Math.round(chapter.end_time! * 1000), label: chapter.title.trim(), source: 'creator' as const }];
  });
  return chapters.length > 0 ? chapters : undefined;
}

export type TranscriptFailureCode =
  | 'binary_missing'
  | 'whisper_binary_missing'
  | 'whisper_model_missing'
  | 'ffmpeg_missing'
  | 'network'
  | 'restricted'
  | 'authentication_required'
  | 'unavailable'
  | 'captions_unavailable'
  | 'captions_rejected'
  | 'invalid_output';

export class TranscriptAcquisitionError extends Error {
  constructor(
    readonly code: TranscriptFailureCode,
    message: string,
    readonly retryable: boolean,
    readonly action: string,
  ) {
    super(message);
    this.name = 'TranscriptAcquisitionError';
  }
}

export interface CaptionAcquisition {
  media: YtDlpMediaMetadata;
  transcript: TranscriptArtifact;
  captionKind: 'creator-captions' | 'automatic-captions';
}

export interface YtDlpTranscriptProviderOptions {
  runner: ProcessRunner;
  fetch?: typeof globalThis.fetch;
  binary?: string;
  toolVersion?: string;
}

export function classifyYtDlpFailure(error: unknown): TranscriptAcquisitionError {
  if (error instanceof ProcessExecutionError && error.reason === 'spawn') {
    return new TranscriptAcquisitionError('binary_missing', 'yt-dlp is not installed or is not executable.', false, 'Run `ft app doctor` for installation instructions.');
  }
  const detail = error instanceof ProcessExecutionError
    ? `${error.result.stderr}\n${error.result.stdout}`.toLowerCase()
    : String(error).toLowerCase();
  if (/sign in|login|authentication|cookies/.test(detail)) {
    return new TranscriptAcquisitionError('authentication_required', 'YouTube requires authentication for this video.', false, 'Open the video on YouTube or retry with an explicitly configured cookie source.');
  }
  if (/age.restrict|private video|members.only|region|country|not available in your/.test(detail)) {
    return new TranscriptAcquisitionError('restricted', 'YouTube restricts access to this video.', false, 'Open the source on YouTube to review its access requirements.');
  }
  if (/unavailable|removed|does not exist/.test(detail)) {
    return new TranscriptAcquisitionError('unavailable', 'The YouTube video is unavailable.', false, 'Check whether the source was removed or made private.');
  }
  return new TranscriptAcquisitionError('network', 'yt-dlp could not retrieve video metadata.', true, 'Check the network connection and retry.');
}

function languageCandidates(metadata: YtDlpMetadata, requestedLanguage?: string): string[] {
  const values = [requestedLanguage, 'en', metadata.language].filter((value): value is string => Boolean(value));
  return [...new Set(values.map((value) => value.toLowerCase()))];
}

function chooseLanguage(tracks: Record<string, CaptionFormat[]> | undefined, candidates: string[]): string | null {
  if (!tracks) return null;
  const keys = Object.keys(tracks).filter((key) => key !== 'live_chat');
  for (const candidate of candidates) {
    const exact = keys.find((key) => key.toLowerCase() === candidate);
    if (exact) return exact;
    const regional = keys.find((key) => key.toLowerCase().startsWith(`${candidate}-`) && !key.toLowerCase().includes('orig'));
    if (regional) return regional;
  }
  return keys.find((key) => !key.includes('-')) ?? keys[0] ?? null;
}

function chooseFormat(formats: CaptionFormat[]): CaptionFormat | null {
  return formats.find((format) => format.ext === 'json3' && format.url)
    ?? formats.find((format) => format.ext === 'vtt' && format.url)
    ?? formats.find((format) => Boolean(format.url))
    ?? null;
}

function isTrustedCaptionHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'youtube.com'
    || host.endsWith('.youtube.com')
    || host === 'googlevideo.com'
    || host.endsWith('.googlevideo.com');
}

const MAX_CAPTION_BYTES = 20 * 1024 * 1024;

function trustedCaptionUrl(value: string | URL, base?: URL): URL {
  let url: URL;
  try {
    url = base ? new URL(value, base) : new URL(value);
  } catch {
    throw new TranscriptAcquisitionError('invalid_output', 'yt-dlp returned an invalid caption URL.', true, 'Update yt-dlp and retry.');
  }
  if (url.protocol !== 'https:' || !isTrustedCaptionHost(url.hostname)) {
    throw new TranscriptAcquisitionError('invalid_output', 'yt-dlp returned an untrusted caption URL.', false, 'Update yt-dlp before retrying.');
  }
  return url;
}

async function readCaptionText(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_CAPTION_BYTES) {
    throw new TranscriptAcquisitionError('invalid_output', 'The caption track exceeds the 20 MB safety limit.', false, 'Use local transcription for this video.');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_CAPTION_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new TranscriptAcquisitionError('invalid_output', 'The caption track exceeds the 20 MB safety limit.', false, 'Use local transcription for this video.');
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
}

function parseJson3(value: unknown): RawTranscriptSegment[] {
  const events = (value as { events?: Array<{ tStartMs?: number; dDurationMs?: number; segs?: Array<{ utf8?: string }> }> }).events ?? [];
  return events.flatMap((event) => {
    const text = (event.segs ?? []).map((segment) => segment.utf8 ?? '').join('').trim();
    if (!text || !Number.isFinite(event.tStartMs) || !Number.isFinite(event.dDurationMs) || (event.dDurationMs ?? 0) <= 0) return [];
    const startMs = Math.round(event.tStartMs!);
    return [{ startMs, endMs: startMs + Math.round(event.dDurationMs!), text }];
  });
}

function parseVttTimestamp(value: string): number {
  const parts = value.replace(',', '.').split(':').map(Number);
  if (parts.some((part) => !Number.isFinite(part))) return Number.NaN;
  const [hours, minutes, seconds] = parts.length === 3 ? parts : [0, parts[0], parts[1]];
  return Math.round(((hours * 60 + minutes) * 60 + seconds) * 1000);
}

function parseVtt(value: string): RawTranscriptSegment[] {
  const lines = value.replace(/\r/g, '').split('\n');
  const segments: RawTranscriptSegment[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^(\d{1,2}:)?\d{2}:\d{2}[.,]\d{3}\s+-->\s+((\d{1,2}:)?\d{2}:\d{2}[.,]\d{3})/);
    if (!match) continue;
    const [from, to] = lines[index].split(/\s+-->\s+/);
    const text: string[] = [];
    while (++index < lines.length && lines[index].trim()) text.push(lines[index].replace(/<[^>]+>/g, '').trim());
    const startMs = parseVttTimestamp(from);
    const endMs = parseVttTimestamp(to.split(/\s+/)[0]);
    const normalized = text.join(' ').replace(/\s+/g, ' ').trim();
    if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs && normalized) {
      segments.push({ startMs, endMs, text: normalized });
    }
  }
  return segments;
}

export function assessTranscriptQuality(segments: RawTranscriptSegment[], durationMs: number): string[] {
  const reasons: string[] = [];
  if (segments.length === 0) return ['Transcript contains no timed segments.'];
  const coveredMs = segments.reduce((total, segment) => total + Math.max(0, segment.endMs - segment.startMs), 0);
  if (durationMs > 0 && coveredMs / durationMs < 0.5) reasons.push('Transcript covers less than 50% of the media duration.');
  const words = segments.flatMap((segment) => segment.text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? []);
  if (new Set(words).size < 8) reasons.push('Transcript has insufficient lexical content.');
  const normalized = segments.map((segment) => segment.text.toLowerCase().replace(/\s+/g, ' ').trim());
  const mostRepeated = Math.max(...Array.from(new Set(normalized), (text) => normalized.filter((item) => item === text).length));
  if (segments.length >= 4 && mostRepeated / segments.length > 0.6) reasons.push('Transcript is dominated by repeated caption text.');
  return reasons;
}

export class YtDlpTranscriptProvider {
  private readonly runner: ProcessRunner;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly binary: string;
  private readonly toolVersion?: string;

  constructor(options: YtDlpTranscriptProviderOptions) {
    this.runner = options.runner;
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.binary = options.binary ?? 'yt-dlp';
    this.toolVersion = options.toolVersion;
  }

  private async metadata(url: string, signal?: AbortSignal): Promise<YtDlpMetadata> {
    let metadata: YtDlpMetadata;
    try {
      const result = await this.runner.run({
        command: this.binary,
        args: ['--no-config', '--no-playlist', '--skip-download', '--no-warnings', '--dump-single-json', url],
        timeoutMs: 120_000,
        signal,
      });
      metadata = JSON.parse(result.stdout) as YtDlpMetadata;
    } catch (error) {
      if (error instanceof ProcessExecutionError && error.reason === 'aborted') throw error;
      if (error instanceof SyntaxError) {
        throw new TranscriptAcquisitionError('invalid_output', 'yt-dlp returned invalid metadata JSON.', true, 'Update yt-dlp and retry.');
      }
      throw classifyYtDlpFailure(error);
    }
    if (!metadata.id || !metadata.title || !Number.isFinite(metadata.duration) || metadata.duration! <= 0) {
      throw new TranscriptAcquisitionError('invalid_output', 'yt-dlp metadata is missing the video ID, title, or duration.', true, 'Update yt-dlp and retry.');
    }
    return metadata;
  }

  async acquireMetadata(url: string, signal?: AbortSignal): Promise<YtDlpMediaMetadata> {
    const metadata = await this.metadata(url, signal);
    return {
      videoId: metadata.id,
      title: metadata.title!,
      creator: metadata.channel ?? metadata.uploader ?? 'Unknown creator',
      durationMs: Math.round(metadata.duration! * 1000),
      ...(metadata.thumbnail ? { thumbnailUrl: metadata.thumbnail } : {}),
      ...(metadata.language ? { language: metadata.language } : {}),
      ...(metadataChapters(metadata) ? { creatorChapters: metadataChapters(metadata) } : {}),
    };
  }

  async acquire(url: string, requestedLanguage?: string, signal?: AbortSignal): Promise<CaptionAcquisition> {
    const metadata = await this.metadata(url, signal);

    const candidates = languageCandidates(metadata, requestedLanguage);
    const creatorLanguage = chooseLanguage(metadata.subtitles, candidates);
    const automaticLanguage = creatorLanguage ? null : chooseLanguage(metadata.automatic_captions, candidates);
    const language = creatorLanguage ?? automaticLanguage;
    const collection = creatorLanguage ? metadata.subtitles : metadata.automatic_captions;
    const format = language ? chooseFormat(collection?.[language] ?? []) : null;
    if (!language || !format?.url) {
      throw new TranscriptAcquisitionError('captions_unavailable', 'No usable creator or automatic captions were found.', false, 'Install the local transcription dependencies shown by `ft app doctor`.');
    }

    let captionUrl = trustedCaptionUrl(format.url);

    let response: Response;
    try {
      const fetchSignal = signal
        ? AbortSignal.any([signal, AbortSignal.timeout(60_000)])
        : AbortSignal.timeout(60_000);
      for (let redirects = 0; ; redirects += 1) {
        response = await this.fetcher(captionUrl, { signal: fetchSignal, redirect: 'manual' });
        if (response.status < 300 || response.status >= 400) break;
        if (redirects >= 3) throw new TranscriptAcquisitionError('invalid_output', 'The caption download exceeded the redirect limit.', false, 'Refresh video metadata and retry.');
        const location = response.headers.get('location');
        if (!location) throw new TranscriptAcquisitionError('invalid_output', 'The caption download returned a redirect without a destination.', true, 'Refresh video metadata and retry.');
        captionUrl = trustedCaptionUrl(location, captionUrl);
      }
    } catch (error) {
      if (error instanceof TranscriptAcquisitionError) throw error;
      if (signal?.aborted) throw error;
      throw new TranscriptAcquisitionError('network', 'The selected caption track could not be downloaded.', true, 'Check the network connection and retry.');
    }
    if (!response.ok) {
      throw new TranscriptAcquisitionError('network', `Caption download failed with HTTP ${response.status}.`, response.status >= 500, 'Refresh video metadata and retry.');
    }
    const raw = await readCaptionText(response);
    let segments: RawTranscriptSegment[];
    try {
      segments = format.ext === 'json3' ? parseJson3(JSON.parse(raw)) : parseVtt(raw);
    } catch {
      throw new TranscriptAcquisitionError('invalid_output', 'The caption track could not be parsed.', true, 'Refresh video metadata and retry.');
    }
    const durationMs = Math.round(metadata.duration! * 1000);
    const qualityReasons = assessTranscriptQuality(segments, durationMs);
    if (qualityReasons.length > 0) {
      throw new TranscriptAcquisitionError('captions_rejected', qualityReasons.join(' '), false, 'Use local transcription for this video.');
    }

    const captionKind = creatorLanguage ? 'creator-captions' : 'automatic-captions';
    return {
      media: {
        videoId: metadata.id,
        title: metadata.title!,
        creator: metadata.channel ?? metadata.uploader ?? 'Unknown creator',
        durationMs,
        ...(metadata.thumbnail ? { thumbnailUrl: metadata.thumbnail } : {}),
        language,
        ...(metadataChapters(metadata) ? { creatorChapters: metadataChapters(metadata) } : {}),
      },
      captionKind,
      transcript: normalizeTranscript(language, {
        provider: 'yt-dlp',
        ...(this.toolVersion ? { toolVersion: this.toolVersion } : {}),
        source: captionKind,
      }, segments),
    };
  }
}
