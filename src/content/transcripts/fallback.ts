import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { ensureDir } from '../../fs.js';
import type { ProcessRunner } from '../process-runner.js';
import { ProcessExecutionError } from '../process-runner.js';
import type { TranscriptArtifact } from '../types.js';
import { persistTranscriptArtifact } from './artifact-store.js';
import { classifyYtDlpFailure, TranscriptAcquisitionError, YtDlpTranscriptProvider, type YtDlpMediaMetadata } from './yt-dlp.js';
import { WhisperCppTranscriptProvider } from './whisper-cpp.js';

export interface TranscriptFallbackOptions {
  runner: ProcessRunner;
  captionProvider: YtDlpTranscriptProvider;
  whisperProvider: WhisperCppTranscriptProvider;
  contentRoot: string;
  tempRoot: string;
  ytDlpBinary?: string;
  maxLocalDurationMs?: number;
}

export interface AcquiredTranscript {
  media: YtDlpMediaMetadata;
  transcript: TranscriptArtifact;
  artifactPath: string;
  source: 'creator-captions' | 'automatic-captions' | 'local-transcription';
}

export class TranscriptFallbackPipeline {
  constructor(private readonly options: TranscriptFallbackOptions) {}

  async acquire(url: string, requestedLanguage?: string, signal?: AbortSignal): Promise<AcquiredTranscript> {
    try {
      const captions = await this.options.captionProvider.acquire(url, requestedLanguage);
      const artifactPath = await persistTranscriptArtifact(this.options.contentRoot, captions.transcript);
      return { ...captions, artifactPath, source: captions.captionKind };
    } catch (error) {
      if (!(error instanceof TranscriptAcquisitionError) || !['captions_unavailable', 'captions_rejected'].includes(error.code)) throw error;
    }

    const metadataOnly = await this.options.captionProvider.acquireMetadata(url);
    const maxDurationMs = this.options.maxLocalDurationMs ?? 2 * 60 * 60_000;
    if (metadataOnly.durationMs > maxDurationMs) {
      throw new TranscriptAcquisitionError('captions_unavailable', `Local transcription is limited to ${Math.round(maxDurationMs / 60000)} minutes for this item.`, false, 'Use the explicit per-item long-transcription override to continue.');
    }

    await ensureDir(this.options.tempRoot);
    const workDir = await mkdtemp(path.join(this.options.tempRoot, 'transcript-'));
    const audioPath = path.join(workDir, 'audio.wav');
    const outputPrefix = path.join(workDir, 'transcript');
    try {
      await this.options.runner.run({
        command: this.options.ytDlpBinary ?? 'yt-dlp',
        args: ['--no-config', '--no-playlist', '--no-warnings', '--extract-audio', '--audio-format', 'wav', '--postprocessor-args', 'ffmpeg:-ar 16000 -ac 1', '--output', path.join(workDir, 'audio.%(ext)s'), url],
        timeoutMs: 15 * 60_000,
        maxOutputBytes: 2 * 1024 * 1024,
        signal,
      });
    } catch (error) {
      if (error instanceof ProcessExecutionError && error.reason === 'aborted') throw error;
      throw classifyYtDlpFailure(error);
    }
    const transcript = await this.options.whisperProvider.transcribe(audioPath, outputPrefix, metadataOnly.durationMs, signal);
    const artifactPath = await persistTranscriptArtifact(this.options.contentRoot, transcript);
    await rm(workDir, { recursive: true, force: true });
    return { media: metadataOnly, transcript, artifactPath, source: 'local-transcription' };
  }
}
