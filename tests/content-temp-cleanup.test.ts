import assert from 'node:assert/strict';
import { mkdir, mkdtemp, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { cleanupOrphanedTempFiles } from '../src/content/temp-cleanup.js';

test('startup temp cleanup removes only stale inactive transcription work', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ft-temp-cleanup-'));
  const stale = path.join(root, 'transcript-stale');
  const active = path.join(root, 'transcript-active');
  const recent = path.join(root, 'transcript-recent');
  await Promise.all([mkdir(stale), mkdir(active), mkdir(recent)]);
  await Promise.all([writeFile(path.join(stale, 'audio.wav'), 'old'), writeFile(path.join(active, 'audio.wav'), 'active')]);
  const old = new Date('2026-08-10T00:00:00.000Z');
  await Promise.all([utimes(stale, old, old), utimes(active, old, old)]);
  const result = await cleanupOrphanedTempFiles(root, { now: Date.parse('2026-08-12T00:00:00.000Z'), activePaths: new Set([active]) });
  assert.deepEqual(result, { inspected: 3, removed: 1, retained: 2 });
  await assert.rejects(stat(stale));
  assert.equal((await stat(active)).isDirectory(), true);
  assert.equal((await stat(recent)).isDirectory(), true);
});
