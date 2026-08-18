import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { startContentApp } from '../src/content/app.js';
import type { SyncResult } from '../src/graphql-bookmarks.js';

test('content app starts an authenticated loopback server and closes cleanly', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ft-content-app-'));
  const previousData = process.env.FT_DATA_DIR;
  const previousContent = process.env.FT_CONTENT_DIR;
  process.env.FT_DATA_DIR = path.join(root, 'bookmarks');
  process.env.FT_CONTENT_DIR = path.join(root, 'content');
  let syncAborted = false;
  try {
    const app = await startContentApp({
      open: false,
      pollMs: 25,
      syncBookmarks: async (options): Promise<SyncResult> => new Promise((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => {
          syncAborted = true;
          reject(options.signal?.reason);
        }, { once: true });
      }),
    });
    assert.match(app.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
    const bootstrap = await fetch(app.bootstrapUrl, { redirect: 'manual' });
    assert.equal(bootstrap.status, 303);
    assert.match(bootstrap.headers.get('set-cookie') ?? '', /HttpOnly/);
    await app.close();
    assert.equal(syncAborted, true);
    await assert.rejects(fetch(app.origin));
  } finally {
    if (previousData === undefined) delete process.env.FT_DATA_DIR; else process.env.FT_DATA_DIR = previousData;
    if (previousContent === undefined) delete process.env.FT_CONTENT_DIR; else process.env.FT_CONTENT_DIR = previousContent;
    await rm(root, { recursive: true, force: true });
  }
});

test('content app close remains bounded when sync ignores cancellation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ft-content-app-deadline-'));
  const previousData = process.env.FT_DATA_DIR;
  const previousContent = process.env.FT_CONTENT_DIR;
  process.env.FT_DATA_DIR = path.join(root, 'bookmarks');
  process.env.FT_CONTENT_DIR = path.join(root, 'content');
  try {
    const app = await startContentApp({
      open: false,
      shutdownTimeoutMs: 30,
      syncBookmarks: async (): Promise<SyncResult> => new Promise(() => undefined),
    });
    const startedAt = Date.now();
    await app.close();
    assert.ok(Date.now() - startedAt < 500, 'close should honor the configured shutdown deadline');
  } finally {
    if (previousData === undefined) delete process.env.FT_DATA_DIR; else process.env.FT_DATA_DIR = previousData;
    if (previousContent === undefined) delete process.env.FT_CONTENT_DIR; else process.env.FT_CONTENT_DIR = previousContent;
    await rm(root, { recursive: true, force: true });
  }
});

test('content app prints the one-time URL when automatic browser launch fails', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ft-content-app-browser-fallback-'));
  const previousData = process.env.FT_DATA_DIR;
  const previousContent = process.env.FT_CONTENT_DIR;
  process.env.FT_DATA_DIR = path.join(root, 'bookmarks');
  process.env.FT_CONTENT_DIR = path.join(root, 'content');
  const statuses: string[] = [];
  try {
    const app = await startContentApp({
      sync: false,
      onStatus: (message) => statuses.push(message),
      openBrowser: async () => { throw new Error('launcher unavailable'); },
    });
    assert.ok(statuses.some((message) => message.includes('Could not open a browser automatically (launcher unavailable).')));
    assert.ok(statuses.includes(`Open once: ${app.bootstrapUrl}`));
    await app.close();
  } finally {
    if (previousData === undefined) delete process.env.FT_DATA_DIR; else process.env.FT_DATA_DIR = previousData;
    if (previousContent === undefined) delete process.env.FT_CONTENT_DIR; else process.env.FT_CONTENT_DIR = previousContent;
    await rm(root, { recursive: true, force: true });
  }
});
