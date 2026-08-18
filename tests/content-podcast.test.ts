import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ProcessRunner } from '../src/content/process-runner.js';
import { PodcastTranscriptPipeline } from '../src/content/transcripts/podcast.js';
import { WhisperCppTranscriptProvider } from '../src/content/transcripts/whisper-cpp.js';
import { TranscriptAcquisitionError } from '../src/content/transcripts/yt-dlp.js';
import whisperFixture from './fixtures/whisper-output.json' with { type: 'json' };

const episodeUrl = 'https://podcast.example/episode/one';
const feedUrl = 'https://podcast.example/feed.xml';
const transcriptUrl = 'https://cdn.example/episode.vtt';
const chaptersUrl = 'https://cdn.example/chapters.json';

const page = `<!doctype html><title>Episode One</title><meta property="og:title" content="Episode One"><link rel="alternate" type="application/rss+xml" href="${feedUrl}">`;
const feed = `<?xml version="1.0"?><rss><channel><title>Fixture Show</title><itunes:author>Fixture Host</itunes:author><language>en</language><item><title>Episode One</title><link>${episodeUrl}</link><itunes:duration>00:03:00</itunes:duration><itunes:image href="https://cdn.example/art.jpg"/><enclosure url="https://cdn.example/episode.mp3" type="audio/mpeg" length="123"/><podcast:chapters url="${chaptersUrl}" type="application/json"/><podcast:transcript url="${transcriptUrl}" type="text/vtt" language="en"/></item></channel></rss>`;
const transcript = `WEBVTT\n\n00:00:00.000 --> 00:01:00.000\nThe opening establishes a practical question and explains why the subject matters.\n\n00:01:00.000 --> 00:02:00.000\nThe middle presents a concrete mechanism with enough detail to evaluate the tradeoffs.\n\n00:02:00.000 --> 00:03:00.000\nThe conclusion summarizes the evidence and proposes a useful next step for listeners.\n`;
const chapterDocument = JSON.stringify({ chapters: [{ startTime: 0, title: 'The question' }, { startTime: 60, title: 'The mechanism' }, { startTime: 120, title: 'The next step' }] });

function fixtureFetch(input: string | URL | Request): Promise<Response> {
  const url = String(input);
  const body = url === episodeUrl ? page : url === feedUrl ? feed : url === transcriptUrl ? transcript : url === chaptersUrl ? chapterDocument : '';
  return Promise.resolve(new Response(body, { status: body ? 200 : 404, headers: { 'content-type': url.endsWith('.json') ? 'application/json' : 'text/plain' } }));
}

test('resolves feed-backed podcast metadata, chapters, and publisher transcripts', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fieldtheory-podcast-'));
  const runner: ProcessRunner = { run: async () => { throw new Error('Publisher transcripts must not invoke media tools.'); } };
  const pipeline = new PodcastTranscriptPipeline({
    runner,
    whisperProvider: new WhisperCppTranscriptProvider({ runner, binary: 'whisper-cli', modelPath: '/unused/model.bin' }),
    contentRoot: root,
    tempRoot: path.join(root, 'tmp'),
    fetch: fixtureFetch,
  });
  const metadata = await pipeline.acquireMetadata(episodeUrl);
  assert.equal(metadata.title, 'Episode One');
  assert.equal(metadata.creator, 'Fixture Host');
  assert.equal(metadata.durationMs, 180_000);
  assert.equal(metadata.mediaUrl, 'https://cdn.example/episode.mp3');
  assert.deepEqual(metadata.creatorChapters?.map((chapter) => chapter.label), ['The question', 'The mechanism', 'The next step']);
  const acquired = await pipeline.acquire(episodeUrl);
  assert.equal(acquired.source, 'publisher-transcript');
  assert.equal(acquired.transcript.provenance.source, 'publisher-transcript');
  assert.equal(acquired.transcript.segments.length, 3);
  assert.equal(JSON.parse(await readFile(acquired.artifactPath, 'utf8')).contentHash, acquired.transcript.contentHash);
});

test('falls back to bounded local transcription when the feed has no publisher transcript', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fieldtheory-podcast-fallback-'));
  const feedWithoutTranscript = feed.replace(/<podcast:transcript\b[^>]*\/>/, '');
  const requests: string[] = [];
  const runner: ProcessRunner = { run: async (request) => {
    requests.push(request.command);
    const outputIndex = request.args.indexOf('--output-file');
    if (outputIndex >= 0) await writeFile(`${request.args[outputIndex + 1]}.json`, JSON.stringify(whisperFixture));
    return { exitCode: 0, stdout: '', stderr: '' };
  } };
  const fallbackFetch = (input: string | URL | Request): Promise<Response> => {
    const url = String(input);
    const body = url === episodeUrl ? page : url === feedUrl ? feedWithoutTranscript : url === chaptersUrl ? chapterDocument : url === 'https://cdn.example/episode.mp3' ? 'fixture-audio' : '';
    return Promise.resolve(new Response(body, { status: body ? 200 : 404 }));
  };
  const pipeline = new PodcastTranscriptPipeline({
    runner,
    whisperProvider: new WhisperCppTranscriptProvider({ runner, binary: 'whisper-cli', modelPath: '/models/base.bin' }),
    contentRoot: root,
    tempRoot: path.join(root, 'tmp'),
    fetch: fallbackFetch,
  });
  const acquired = await pipeline.acquire(episodeUrl);
  assert.equal(acquired.source, 'local-transcription');
  assert.deepEqual(requests, ['ffmpeg', 'whisper-cli']);
});

test('rejects credential-bearing feed URLs before following them', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fieldtheory-podcast-safety-'));
  const credentialUrl = 'https://user:' + 'credential' + '@' + 'podcast.example/feed.xml';
  const unsafePage = `<link rel="alternate" type="application/rss+xml" href="${credentialUrl}">`;
  const runner: ProcessRunner = { run: async () => { throw new Error('unused'); } };
  const pipeline = new PodcastTranscriptPipeline({
    runner,
    whisperProvider: new WhisperCppTranscriptProvider({ runner, binary: 'whisper-cli', modelPath: '/unused' }),
    contentRoot: root,
    tempRoot: path.join(root, 'tmp'),
    fetch: async (input) => new Response(String(input) === episodeUrl ? unsafePage : '', { status: String(input) === episodeUrl ? 200 : 404 }),
  });
  await assert.rejects(pipeline.acquireMetadata(episodeUrl), (error: unknown) => error instanceof TranscriptAcquisitionError && error.code === 'invalid_output');
});
