import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import metadataFixture from './fixtures/yt-dlp-metadata.json' with { type: 'json' };
import whisperFixture from './fixtures/whisper-output.json' with { type: 'json' };
import type { ProcessRequest, ProcessResult, ProcessRunner } from '../src/content/process-runner.js';
import { WhisperCppTranscriptProvider } from '../src/content/transcripts/whisper-cpp.js';
import { YtDlpTranscriptProvider, TranscriptAcquisitionError } from '../src/content/transcripts/yt-dlp.js';
import { TranscriptFallbackPipeline } from '../src/content/transcripts/fallback.js';

class WhisperFixtureRunner implements ProcessRunner {
  requests: ProcessRequest[] = [];

  async run(request: ProcessRequest): Promise<ProcessResult> {
    this.requests.push(request);
    const outputIndex = request.args.indexOf('--output-file');
    if (outputIndex >= 0) await writeFile(`${request.args[outputIndex + 1]}.json`, JSON.stringify(whisperFixture));
    return { exitCode: 0, stdout: request.command === 'yt-dlp' ? JSON.stringify(metadataFixture) : '', stderr: '' };
  }
}

test('normalizes timestamped whisper.cpp JSON without coupling to console output', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fieldtheory-whisper-'));
  const runner = new WhisperFixtureRunner();
  const provider = new WhisperCppTranscriptProvider({ runner, binary: 'whisper-cli', modelPath: '/models/base.bin', toolVersion: '1.8.2' });
  const transcript = await provider.transcribe(path.join(root, 'audio.wav'), path.join(root, 'output'), 180000);
  assert.equal(transcript.language, 'en');
  assert.equal(transcript.provenance.source, 'local-transcription');
  assert.equal(transcript.segments[0].startMs, 0);
  assert.equal(transcript.segments[2].endMs, 180000);
  assert.deepEqual(runner.requests[0].args.slice(0, 4), ['--model', '/models/base.bin', '--file', path.join(root, 'audio.wav')]);
});

test('falls back from missing captions to local transcription and deletes temp audio only after persistence', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fieldtheory-fallback-'));
  const runner = new WhisperFixtureRunner();
  const noCaptions = structuredClone(metadataFixture);
  noCaptions.subtitles = {};
  noCaptions.automatic_captions = {};
  runner.run = async (request: ProcessRequest): Promise<ProcessResult> => {
    runner.requests.push(request);
    const outputIndex = request.args.indexOf('--output-file');
    if (outputIndex >= 0) await writeFile(`${request.args[outputIndex + 1]}.json`, JSON.stringify(whisperFixture));
    return { exitCode: 0, stdout: request.args.includes('--dump-single-json') ? JSON.stringify(noCaptions) : '', stderr: '' };
  };
  const captionProvider = new YtDlpTranscriptProvider({ runner, fetch: async () => new Response('', { status: 404 }) });
  const whisperProvider = new WhisperCppTranscriptProvider({ runner, binary: 'whisper-cli', modelPath: '/models/base.bin' });
  const pipeline = new TranscriptFallbackPipeline({ runner, captionProvider, whisperProvider, contentRoot: root, tempRoot: path.join(root, 'tmp') });
  const result = await pipeline.acquire('https://youtu.be/dQw4w9WgXcQ');

  assert.equal(result.source, 'local-transcription');
  assert.equal(JSON.parse(await readFile(result.artifactPath, 'utf8')).contentHash, result.transcript.contentHash);
  assert.ok(runner.requests.some((request) => request.args.includes('--extract-audio')));
  const tempEntries = await import('node:fs/promises').then(({ readdir }) => readdir(path.join(root, 'tmp')));
  assert.deepEqual(tempEntries, []);
});

test('blocks no-caption videos beyond the local duration limit without extracting audio', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fieldtheory-fallback-'));
  const runner = new WhisperFixtureRunner();
  const noCaptions = structuredClone(metadataFixture);
  noCaptions.duration = 3 * 60 * 60;
  noCaptions.subtitles = {};
  noCaptions.automatic_captions = {};
  runner.run = async (request: ProcessRequest): Promise<ProcessResult> => {
    runner.requests.push(request);
    return { exitCode: 0, stdout: JSON.stringify(noCaptions), stderr: '' };
  };
  const captionProvider = new YtDlpTranscriptProvider({ runner, fetch: async () => new Response('', { status: 404 }) });
  const whisperProvider = new WhisperCppTranscriptProvider({ runner, binary: 'whisper-cli', modelPath: '/models/base.bin' });
  const pipeline = new TranscriptFallbackPipeline({ runner, captionProvider, whisperProvider, contentRoot: root, tempRoot: path.join(root, 'tmp') });
  await assert.rejects(pipeline.acquire('https://youtu.be/dQw4w9WgXcQ'), (error: unknown) =>
    error instanceof TranscriptAcquisitionError && error.code === 'captions_unavailable' && error.action.includes('override'));
  assert.equal(runner.requests.some((request) => request.args.includes('--extract-audio')), false);
});
