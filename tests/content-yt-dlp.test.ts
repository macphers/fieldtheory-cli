import test from 'node:test';
import assert from 'node:assert/strict';
import metadata from './fixtures/yt-dlp-metadata.json' with { type: 'json' };
import captions from './fixtures/youtube-captions-json3.json' with { type: 'json' };
import type { ProcessRequest, ProcessResult, ProcessRunner } from '../src/content/process-runner.js';
import { ProcessExecutionError } from '../src/content/process-runner.js';
import {
  assessTranscriptQuality,
  TranscriptAcquisitionError,
  YtDlpTranscriptProvider,
} from '../src/content/transcripts/yt-dlp.js';

class FixtureRunner implements ProcessRunner {
  requests: ProcessRequest[] = [];

  constructor(private readonly value: unknown = metadata, private readonly error?: Error) {}

  async run(request: ProcessRequest): Promise<ProcessResult> {
    this.requests.push(request);
    if (this.error) throw this.error;
    return { exitCode: 0, stdout: JSON.stringify(this.value), stderr: '' };
  }
}

function fixtureFetch(body: unknown, status = 200): typeof globalThis.fetch {
  return async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
}

test('acquires creator captions with normalized media and stable transcript identity', async () => {
  const runner = new FixtureRunner();
  const provider = new YtDlpTranscriptProvider({ runner, fetch: fixtureFetch(captions), toolVersion: '2026.08.11' });
  const result = await provider.acquire('https://youtu.be/dQw4w9WgXcQ');

  assert.equal(result.captionKind, 'creator-captions');
  assert.equal(result.media.durationMs, 180000);
  assert.equal(result.transcript.provenance.source, 'creator-captions');
  assert.equal(result.transcript.segments.length, 3);
  assert.match(result.transcript.contentHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(runner.requests[0].args.slice(0, 2), ['--no-config', '--no-playlist']);
  assert.equal(runner.requests[0].args.includes('--cookies-from-browser'), false);
});

test('falls back to automatic captions only when creator captions are absent', async () => {
  const value = structuredClone(metadata);
  value.subtitles = {};
  const provider = new YtDlpTranscriptProvider({ runner: new FixtureRunner(value), fetch: fixtureFetch(captions) });
  const result = await provider.acquire('https://youtu.be/dQw4w9WgXcQ');
  assert.equal(result.captionKind, 'automatic-captions');
  assert.equal(result.transcript.provenance.source, 'automatic-captions');
});

test('uses VTT captions when JSON3 is unavailable', async () => {
  const value = structuredClone(metadata);
  value.subtitles.en = [{ ext: 'vtt', url: 'https://www.youtube.com/api/timedtext?v=test', name: 'English' }];
  const vtt = `WEBVTT\n\n00:00:00.000 --> 00:01:00.000\nThe opening establishes a practical question and why it matters.\n\n00:01:00.000 --> 00:02:00.000\nThe middle introduces a mechanism with evidence and an example.\n\n00:02:00.000 --> 00:03:00.000\nThe conclusion compares tradeoffs and proposes a useful next action.\n`;
  const provider = new YtDlpTranscriptProvider({ runner: new FixtureRunner(value), fetch: fixtureFetch(vtt) });
  const result = await provider.acquire('https://youtu.be/dQw4w9WgXcQ');
  assert.equal(result.transcript.segments.length, 3);
  assert.equal(result.transcript.segments[1].startMs, 60000);
});

test('classifies unavailable captions and actionable yt-dlp failures', async () => {
  const noCaptions = structuredClone(metadata);
  noCaptions.subtitles = {};
  noCaptions.automatic_captions = {};
  const provider = new YtDlpTranscriptProvider({ runner: new FixtureRunner(noCaptions), fetch: fixtureFetch(captions) });
  await assert.rejects(provider.acquire('https://youtu.be/dQw4w9WgXcQ'), (error: unknown) =>
    error instanceof TranscriptAcquisitionError && error.code === 'captions_unavailable' && !error.retryable);

  const result = { exitCode: 1, stdout: '', stderr: 'This video is not available in your country' };
  const restricted = new ProcessExecutionError('failed', result, 'exit');
  const restrictedProvider = new YtDlpTranscriptProvider({ runner: new FixtureRunner({}, restricted), fetch: fixtureFetch(captions) });
  await assert.rejects(restrictedProvider.acquire('https://youtu.be/dQw4w9WgXcQ'), (error: unknown) =>
    error instanceof TranscriptAcquisitionError && error.code === 'restricted' && !error.retryable);
});

test('rejects unsafe caption URLs and malformed provider output', async () => {
  const unsafe = structuredClone(metadata);
  unsafe.subtitles.en[0].url = 'https://127.0.0.1/private';
  const unsafeProvider = new YtDlpTranscriptProvider({ runner: new FixtureRunner(unsafe), fetch: fixtureFetch(captions) });
  await assert.rejects(unsafeProvider.acquire('https://youtu.be/dQw4w9WgXcQ'), (error: unknown) =>
    error instanceof TranscriptAcquisitionError && error.code === 'invalid_output' && error.message.includes('untrusted'));

  const malformed = new FixtureRunner();
  malformed.run = async () => ({ exitCode: 0, stdout: '{broken', stderr: '' });
  const malformedProvider = new YtDlpTranscriptProvider({ runner: malformed, fetch: fixtureFetch(captions) });
  await assert.rejects(malformedProvider.acquire('https://youtu.be/dQw4w9WgXcQ'), (error: unknown) =>
    error instanceof TranscriptAcquisitionError && error.code === 'invalid_output');
});

test('rejects caption redirects to untrusted hosts and oversized bodies before parsing', async () => {
  const redirectProvider = new YtDlpTranscriptProvider({
    runner: new FixtureRunner(),
    fetch: async () => new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/private' } }),
  });
  await assert.rejects(redirectProvider.acquire('https://youtu.be/dQw4w9WgXcQ'), (error: unknown) =>
    error instanceof TranscriptAcquisitionError && error.code === 'invalid_output' && error.message.includes('untrusted'));

  const oversizedProvider = new YtDlpTranscriptProvider({
    runner: new FixtureRunner(),
    fetch: async () => new Response('{}', { status: 200, headers: { 'content-length': String(20 * 1024 * 1024 + 1) } }),
  });
  await assert.rejects(oversizedProvider.acquire('https://youtu.be/dQw4w9WgXcQ'), (error: unknown) =>
    error instanceof TranscriptAcquisitionError && error.code === 'invalid_output' && error.message.includes('20 MB'));
});

test('rejects empty, sparse, and repetitive transcripts deterministically', () => {
  assert.deepEqual(assessTranscriptQuality([], 1000), ['Transcript contains no timed segments.']);
  assert.ok(assessTranscriptQuality([{ startMs: 0, endMs: 1000, text: 'short' }], 10000).length >= 2);
  const repeated = Array.from({ length: 5 }, (_, index) => ({ startMs: index * 1000, endMs: (index + 1) * 1000, text: 'the same repeated caption words forever' }));
  assert.ok(assessTranscriptQuality(repeated, 5000).some((reason) => reason.includes('repeated')));
});
