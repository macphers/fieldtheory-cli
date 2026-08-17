import { readFile } from 'node:fs/promises';
import type { ProcessRunner } from '../process-runner.js';
import { ProcessExecutionError } from '../process-runner.js';
import { normalizeTranscript } from '../knowledge-page.js';
import type { RawTranscriptSegment, TranscriptArtifact } from '../types.js';
import { assessTranscriptQuality, TranscriptAcquisitionError } from './yt-dlp.js';

interface WhisperJson {
  result?: { language?: string };
  transcription?: Array<{
    timestamps?: { from?: string; to?: string };
    text?: string;
  }>;
}

export interface WhisperCppOptions {
  runner: ProcessRunner;
  binary: string;
  modelPath: string;
  toolVersion?: string;
}

function timestampMs(value: string | undefined): number {
  if (!value) return Number.NaN;
  const parts = value.replace(',', '.').split(':').map(Number);
  if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) return Number.NaN;
  return Math.round(((parts[0] * 60 + parts[1]) * 60 + parts[2]) * 1000);
}

function parseWhisperOutput(value: WhisperJson): { language: string; segments: RawTranscriptSegment[] } {
  const language = value.result?.language?.trim().toLowerCase() || 'und';
  const segments = (value.transcription ?? []).flatMap((entry) => {
    const startMs = timestampMs(entry.timestamps?.from);
    const endMs = timestampMs(entry.timestamps?.to);
    const text = entry.text?.replace(/\s+/g, ' ').trim() ?? '';
    return Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs && text
      ? [{ startMs, endMs, text }]
      : [];
  });
  return { language, segments };
}

export class WhisperCppTranscriptProvider {
  constructor(private readonly options: WhisperCppOptions) {}

  async transcribe(audioPath: string, outputPrefix: string, durationMs: number, signal?: AbortSignal): Promise<TranscriptArtifact> {
    if (!this.options.modelPath.trim()) {
      throw new TranscriptAcquisitionError('whisper_model_missing', 'No whisper.cpp model is configured.', false, 'Set FT_WHISPER_MODEL to an installed model shown by `ft app doctor`.');
    }
    try {
      await this.options.runner.run({
        command: this.options.binary,
        args: ['--model', this.options.modelPath, '--file', audioPath, '--language', 'auto', '--output-json-full', '--output-file', outputPrefix, '--no-prints'],
        timeoutMs: Math.max(10 * 60_000, Math.ceil(durationMs * 2)),
        maxOutputBytes: 1024 * 1024,
        signal,
      });
    } catch (error) {
      if (error instanceof ProcessExecutionError && error.reason === 'aborted') throw error;
      if (error instanceof ProcessExecutionError && error.reason === 'spawn') {
        throw new TranscriptAcquisitionError('whisper_binary_missing', 'whisper.cpp is not installed or is not executable.', false, 'Run `ft app doctor` for installation instructions.');
      }
      if (error instanceof ProcessExecutionError && /model|ggml|no such file|failed to open/i.test(`${error.result.stderr}\n${error.result.stdout}`)) {
        throw new TranscriptAcquisitionError('whisper_model_missing', 'The configured whisper.cpp model could not be loaded.', false, 'Install the configured model or update FT_WHISPER_MODEL, then run `ft app doctor`.');
      }
      throw new TranscriptAcquisitionError('invalid_output', 'Local transcription failed before producing a transcript.', true, 'Run `ft app doctor`, verify the model, and retry.');
    }

    let parsed: { language: string; segments: RawTranscriptSegment[] };
    try {
      parsed = parseWhisperOutput(JSON.parse(await readFile(`${outputPrefix}.json`, 'utf8')) as WhisperJson);
    } catch {
      throw new TranscriptAcquisitionError('invalid_output', 'whisper.cpp did not produce valid timestamped JSON.', true, 'Update whisper.cpp or verify the configured model.');
    }
    const qualityReasons = assessTranscriptQuality(parsed.segments, durationMs);
    if (qualityReasons.length > 0) {
      throw new TranscriptAcquisitionError('captions_rejected', qualityReasons.join(' '), false, 'Review the audio quality or use a different Whisper model.');
    }
    return normalizeTranscript(parsed.language, {
      provider: 'whisper.cpp',
      ...(this.options.toolVersion ? { toolVersion: this.options.toolVersion } : {}),
      source: 'local-transcription',
    }, parsed.segments);
  }
}
