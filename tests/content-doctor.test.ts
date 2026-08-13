import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ProcessRequest, ProcessResult, ProcessRunner } from '../src/content/process-runner.js';
import { inspectContentDependencies } from '../src/content/doctor.js';

class DoctorRunner implements ProcessRunner {
  async run(request: ProcessRequest): Promise<ProcessResult> {
    if (request.command === 'missing') throw new Error('ENOENT');
    return { exitCode: 0, stdout: `${request.command} version 1.2.3`, stderr: '' };
  }
}

test('reports ready tools and an explicitly installed model', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fieldtheory-doctor-'));
  const model = path.join(root, 'model.bin');
  await writeFile(model, 'fixture');
  const checks = await inspectContentDependencies({
    runner: new DoctorRunner(), contentRoot: path.join(root, 'content'), platform: 'darwin', arch: 'arm64',
    env: { FT_YTDLP_PATH: 'yt-dlp', FT_FFMPEG_PATH: 'ffmpeg', FT_WHISPER_CPP_PATH: 'whisper-cli', FT_WHISPER_MODEL: model },
  });
  assert.deepEqual(checks.map((check) => check.state), ['ready', 'ready', 'ready', 'ready', 'ready']);
});

test('reports missing dependencies and unsupported Mac architecture with corrective actions', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fieldtheory-doctor-'));
  const checks = await inspectContentDependencies({
    runner: new DoctorRunner(), contentRoot: path.join(root, 'content'), platform: 'darwin', arch: 'x64',
    env: { FT_YTDLP_PATH: 'missing', FT_FFMPEG_PATH: 'ffmpeg', FT_WHISPER_CPP_PATH: 'whisper-cli' },
  });
  assert.equal(checks.find((check) => check.name === 'yt-dlp')?.state, 'missing');
  assert.equal(checks.find((check) => check.name === 'whisper.cpp')?.state, 'unsupported');
  assert.equal(checks.find((check) => check.name === 'whisper-model')?.state, 'missing');
  assert.ok(checks.filter((check) => check.state !== 'ready').every((check) => Boolean(check.action)));
});
