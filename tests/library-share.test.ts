import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { EnvHttpProxyAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { buildCli } from '../src/cli.js';
import { shareLibraryDocument } from '../src/library-share.js';

const HELPER_TOKEN = 'helper-secret-that-must-never-appear';
const DOCUMENT_TITLE = 'Morning Edition — Thursday, July 16, 2026';
const DOCUMENT_CONTENT = `# ${DOCUMENT_TITLE}\n\nReported news.\n`;

interface RequestRecord {
  method: string;
  pathname: string;
  search: string;
  authorization: string | undefined;
  body: Record<string, unknown> | null;
}

interface Harness {
  baseUrl: string;
  requests: RequestRecord[];
  statusPayload: unknown;
  sharePayload: unknown;
  updatePayload: unknown;
  helperStatusCode: number;
  publicStatusCode: number;
  publicTitle: string;
  publicRobots: string;
  ogStatusCode: number;
  ogContentType: string;
  dropCreateResponseOnce: boolean;
  updateFailuresRemaining: number;
  publicFailuresRemaining: number;
  close: () => Promise<void>;
}

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  if (chunks.length === 0) return null;
  return JSON.parse(Buffer.concat(chunks).toString('utf-8')) as Record<string, unknown>;
}

async function createHarness(): Promise<Harness> {
  const requests: RequestRecord[] = [];
  const harness = {
    baseUrl: '',
    requests,
    statusPayload: { ok: true, status: { shared: false } },
    sharePayload: null,
    updatePayload: { ok: true, success: true },
    helperStatusCode: 200,
    publicStatusCode: 200,
    publicTitle: DOCUMENT_TITLE,
    publicRobots: 'noindex, nofollow, noarchive',
    ogStatusCode: 200,
    ogContentType: 'image/png',
    dropCreateResponseOnce: false,
    updateFailuresRemaining: 0,
    publicFailuresRemaining: 0,
    close: async () => {},
  } satisfies Harness;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const body = await readBody(req);
    requests.push({
      method: req.method ?? 'GET',
      pathname: url.pathname,
      search: url.search,
      authorization: typeof req.headers['x-fieldtheory-browser-token'] === 'string'
        ? req.headers['x-fieldtheory-browser-token']
        : undefined,
      body,
    });

    if (url.pathname.startsWith('/native/librarian/')) {
      res.statusCode = harness.helperStatusCode;
      res.setHeader('content-type', 'application/json');
      if (harness.helperStatusCode !== 200) {
        res.end(JSON.stringify({ error: `failure ${HELPER_TOKEN}` }));
      } else if (url.pathname === '/native/librarian/share-status') {
        res.end(JSON.stringify(harness.statusPayload));
      } else if (url.pathname === '/native/librarian/share-reading') {
        const result = (harness.sharePayload as { result?: Record<string, unknown> } | null)?.result;
        if (result) {
          harness.statusPayload = { ok: true, status: { shared: true, ...result } };
        }
        if (harness.dropCreateResponseOnce) {
          harness.dropCreateResponseOnce = false;
          req.socket.destroy();
          return;
        }
        res.end(JSON.stringify(harness.sharePayload));
      } else if (url.pathname === '/native/librarian/update-shared-reading') {
        if (harness.updateFailuresRemaining > 0) {
          harness.updateFailuresRemaining -= 1;
          res.end(JSON.stringify({ ok: true, success: false }));
          return;
        }
        const status = (harness.statusPayload as { status?: Record<string, unknown> } | null)?.status;
        if (status && harness.updatePayload && (harness.updatePayload as Record<string, unknown>).success === true) {
          status.visibility = 'unlisted';
        }
        res.end(JSON.stringify(harness.updatePayload));
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'not found' }));
      }
      return;
    }

    if (url.pathname === '/morning-edition-a1b2c3') {
      if (harness.publicFailuresRemaining > 0) {
        harness.publicFailuresRemaining -= 1;
        res.statusCode = 503;
        res.end('not ready');
        return;
      }
      res.statusCode = harness.publicStatusCode;
      res.setHeader('content-type', 'text/html; charset=utf-8');
      if (harness.publicRobots) res.setHeader('x-robots-tag', harness.publicRobots);
      res.end(`<!doctype html><html><head><title>${harness.publicTitle} – Field Theory</title><meta name="robots" content="${harness.publicRobots}"><meta property="og:image" content="${harness.baseUrl}/api/morning-edition-a1b2c3"></head><body></body></html>`);
      return;
    }

    if (url.pathname === '/api/morning-edition-a1b2c3') {
      res.statusCode = harness.ogStatusCode;
      res.setHeader('content-type', harness.ogContentType);
      res.end('png');
      return;
    }

    res.statusCode = 404;
    res.end('not found');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not expose a port.');
  harness.baseUrl = `http://127.0.0.1:${address.port}`;
  harness.sharePayload = {
    ok: true,
    result: {
      slug: 'morning-edition-a1b2c3',
      url: `${harness.baseUrl}/morning-edition-a1b2c3`,
      visibility: 'unlisted',
    },
  };
  harness.close = () => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  return harness;
}

async function withShareContext(
  fn: (context: { filePath: string; harness: Harness }) => Promise<void>,
): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-library-share-'));
  const root = path.join(tmp, 'library');
  const statePath = path.join(tmp, 'browser-helper.json');
  const filePath = path.join(root, 'briefs', 'morning-edition.md');
  const previous = {
    FT_LIBRARY_DIR: process.env.FT_LIBRARY_DIR,
    FT_BROWSER_HELPER_STATE_PATH: process.env.FT_BROWSER_HELPER_STATE_PATH,
    FT_LIBRARY_SHARE_TEST_ORIGIN: process.env.FT_LIBRARY_SHARE_TEST_ORIGIN,
  };
  const harness = await createHarness();
  process.env.FT_LIBRARY_DIR = root;
  process.env.FT_BROWSER_HELPER_STATE_PATH = statePath;
  process.env.FT_LIBRARY_SHARE_TEST_ORIGIN = harness.baseUrl;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, DOCUMENT_CONTENT);
  fs.writeFileSync(statePath, JSON.stringify({
    host: '127.0.0.1',
    port: Number(new URL(harness.baseUrl).port),
    token: HELPER_TOKEN,
  }));

  try {
    await fn({ filePath, harness });
  } finally {
    await harness.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test('library share creates an unlisted reading and verifies its HTML title and OG image', async () => {
  await withShareContext(async ({ filePath, harness }) => {
    const result = await shareLibraryDocument(filePath, { visibility: 'unlisted' });

    assert.deepEqual(result, {
      path: filePath,
      slug: 'morning-edition-a1b2c3',
      url: `${harness.baseUrl}/morning-edition-a1b2c3`,
      visibility: 'unlisted',
      verified: true,
    });
    assert.deepEqual(harness.requests.map((request) => request.pathname), [
      '/native/librarian/share-status',
      '/native/librarian/share-reading',
      '/native/librarian/share-status',
      '/morning-edition-a1b2c3',
      '/api/morning-edition-a1b2c3',
    ]);
    assert.equal(harness.requests[0].authorization, HELPER_TOKEN);
    assert.equal(harness.requests[0].search, `?path=${encodeURIComponent(filePath)}`);
    assert.deepEqual(harness.requests[1].body, { filePath, visibility: 'unlisted' });
    assert.equal(harness.requests[2].authorization, HELPER_TOKEN);
    assert.equal(harness.requests[3].authorization, undefined);
    assert.equal(harness.requests[4].authorization, undefined);
  });
});

test('library share refreshes an existing reading without changing its URL', async () => {
  await withShareContext(async ({ filePath, harness }) => {
    const existingUrl = `${harness.baseUrl}/morning-edition-a1b2c3`;
    harness.statusPayload = {
      ok: true,
      status: { shared: true, slug: 'morning-edition-a1b2c3', url: existingUrl, visibility: 'listed' },
    };

    const result = await shareLibraryDocument(filePath, { visibility: 'unlisted' });

    assert.equal(result.url, existingUrl);
    assert.deepEqual(harness.requests.map((request) => request.pathname), [
      '/native/librarian/share-status',
      '/native/librarian/update-shared-reading',
      '/native/librarian/share-status',
      '/morning-edition-a1b2c3',
      '/api/morning-edition-a1b2c3',
    ]);
    assert.deepEqual(harness.requests[1].body, {
      filePath,
      content: DOCUMENT_CONTENT,
      title: DOCUMENT_TITLE,
      visibility: 'unlisted',
    });
  });
});

test('library share reconciles an ambiguous create response', async () => {
  await withShareContext(async ({ filePath, harness }) => {
    harness.dropCreateResponseOnce = true;

    const result = await shareLibraryDocument(filePath, { visibility: 'unlisted' });

    assert.equal(result.verified, true);
    assert.deepEqual(harness.requests.map((request) => request.pathname), [
      '/native/librarian/share-status',
      '/native/librarian/share-reading',
      '/native/librarian/share-status',
      '/native/librarian/share-status',
      '/morning-edition-a1b2c3',
      '/api/morning-edition-a1b2c3',
    ]);
  });
});

test('library share retries an idempotent update and transient public propagation', async () => {
  await withShareContext(async ({ filePath, harness }) => {
    harness.statusPayload = {
      ok: true,
      status: {
        shared: true,
        slug: 'morning-edition-a1b2c3',
        url: `${harness.baseUrl}/morning-edition-a1b2c3`,
        visibility: 'listed',
      },
    };
    harness.updateFailuresRemaining = 1;
    harness.publicFailuresRemaining = 1;

    const result = await shareLibraryDocument(filePath, { visibility: 'unlisted' });

    assert.equal(result.verified, true);
    assert.equal(
      harness.requests.filter((request) => request.pathname === '/native/librarian/update-shared-reading').length,
      2,
    );
    assert.equal(
      harness.requests.filter((request) => request.pathname === '/morning-edition-a1b2c3').length,
      2,
    );
  });
});

test('library share fails closed when the helper is unavailable, signed out, or malformed', async (t) => {
  await t.test('unavailable state', async () => {
    await withShareContext(async ({ filePath }) => {
      fs.rmSync(process.env.FT_BROWSER_HELPER_STATE_PATH!);
      await assert.rejects(shareLibraryDocument(filePath, { visibility: 'unlisted' }), /browser helper is not available/i);
    });
  });

  await t.test('signed out create response', async () => {
    await withShareContext(async ({ filePath, harness }) => {
      harness.sharePayload = { ok: true, result: null };
      await assert.rejects(shareLibraryDocument(filePath, { visibility: 'unlisted' }), /did not create a shared reading/i);
    });
  });

  await t.test('signed out share status', async () => {
    await withShareContext(async ({ filePath, harness }) => {
      harness.statusPayload = { ok: true, status: null };
      await assert.rejects(shareLibraryDocument(filePath, { visibility: 'unlisted' }), /open and signed in/i);
    });
  });

  await t.test('malformed shared status', async () => {
    await withShareContext(async ({ filePath, harness }) => {
      harness.statusPayload = { ok: true, status: { shared: true, slug: 'missing-url' } };
      await assert.rejects(shareLibraryDocument(filePath, { visibility: 'unlisted' }), /malformed share status/i);
    });
  });

  await t.test('helper cannot confirm persisted unlisted visibility', async () => {
    await withShareContext(async ({ filePath, harness }) => {
      harness.sharePayload = {
        ok: true,
        result: {
          slug: 'morning-edition-a1b2c3',
          url: `${harness.baseUrl}/morning-edition-a1b2c3`,
        },
      };
      await assert.rejects(shareLibraryDocument(filePath, { visibility: 'unlisted' }), /update Field Theory/i);
    });
  });
});

test('library share fails when public HTML or OG verification fails', async (t) => {
  await t.test('public page is not HTTP 200', async () => {
    await withShareContext(async ({ filePath, harness }) => {
      harness.publicStatusCode = 503;
      await assert.rejects(shareLibraryDocument(filePath, { visibility: 'unlisted' }), /expected HTTP 200/i);
    });
  });

  await t.test('wrong HTML title', async () => {
    await withShareContext(async ({ filePath, harness }) => {
      harness.publicTitle = 'Wrong title';
      await assert.rejects(shareLibraryDocument(filePath, { visibility: 'unlisted' }), /expected title/i);
    });
  });

  await t.test('public page is discoverable instead of unlisted', async () => {
    await withShareContext(async ({ filePath, harness }) => {
      harness.publicRobots = '';
      await assert.rejects(shareLibraryDocument(filePath, { visibility: 'unlisted' }), /not unlisted/i);
    });
  });

  await t.test('wrong OG content type', async () => {
    await withShareContext(async ({ filePath, harness }) => {
      harness.ogContentType = 'image/jpeg';
      await assert.rejects(shareLibraryDocument(filePath, { visibility: 'unlisted' }), /expected image\/png/i);
    });
  });

  await t.test('OG image is not HTTP 200', async () => {
    await withShareContext(async ({ filePath, harness }) => {
      harness.ogStatusCode = 404;
      await assert.rejects(shareLibraryDocument(filePath, { visibility: 'unlisted' }), /expected HTTP 200/i);
    });
  });
});

test('library share rejects unsupported visibility before contacting the helper', async () => {
  await withShareContext(async ({ filePath, harness }) => {
    await assert.rejects(shareLibraryDocument(filePath, { visibility: 'public' }), /only unlisted/i);
    assert.deepEqual(harness.requests, []);
  });
});

test('library share rejects a helper-provided off-origin public URL', async () => {
  await withShareContext(async ({ filePath, harness }) => {
    harness.sharePayload = {
      ok: true,
      result: {
        slug: 'morning-edition-a1b2c3',
        url: 'https://example.com/morning-edition-a1b2c3',
        visibility: 'unlisted',
      },
    };

    await assert.rejects(
      shareLibraryDocument(filePath, { visibility: 'unlisted' }),
      /unexpected page URL/i,
    );
  });
});

test('library share errors never expose the browser-helper token', async () => {
  await withShareContext(async ({ filePath, harness }) => {
    harness.helperStatusCode = 500;
    const error = await shareLibraryDocument(filePath, { visibility: 'unlisted' }).catch((caught) => caught as Error);
    assert.ok(error instanceof Error);
    assert.doesNotMatch(error.message, new RegExp(HELPER_TOKEN));
    assert.doesNotMatch(error.message, /token=/i);
  });
});

test('library share bypasses the global proxy for helper-token requests', async () => {
  const proxyRequests: Array<{ url: string; token: string | undefined }> = [];
  const proxy = http.createServer((req, res) => {
    proxyRequests.push({
      url: req.url ?? '',
      token: typeof req.headers['x-fieldtheory-browser-token'] === 'string'
        ? req.headers['x-fieldtheory-browser-token']
        : undefined,
    });
    res.statusCode = 502;
    res.end('proxy should not receive helper traffic');
  });
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const address = proxy.address();
  if (!address || typeof address === 'string') throw new Error('Proxy test server did not expose a port.');
  const dispatcher = new EnvHttpProxyAgent({
    httpProxy: `http://127.0.0.1:${address.port}`,
    httpsProxy: `http://127.0.0.1:${address.port}`,
    noProxy: '',
  });
  const previousDispatcher = getGlobalDispatcher();
  setGlobalDispatcher(dispatcher);

  try {
    await withShareContext(async ({ filePath, harness }) => {
      harness.statusPayload = { ok: true, status: { malformed: true } };
      await assert.rejects(shareLibraryDocument(filePath, { visibility: 'unlisted' }), /malformed share status/i);
    });
    assert.deepEqual(proxyRequests, []);
  } finally {
    setGlobalDispatcher(previousDispatcher);
    await dispatcher.close();
    await new Promise<void>((resolve, reject) => proxy.close((error) => error ? reject(error) : resolve()));
  }
});

test('library share rejects a non-loopback helper without transmitting its token', async () => {
  await withShareContext(async ({ filePath, harness }) => {
    fs.writeFileSync(process.env.FT_BROWSER_HELPER_STATE_PATH!, JSON.stringify({
      host: '0.0.0.0',
      port: Number(new URL(harness.baseUrl).port),
      token: HELPER_TOKEN,
    }));

    const error = await shareLibraryDocument(filePath, { visibility: 'unlisted' }).catch((caught) => caught as Error);
    assert.ok(error instanceof Error);
    assert.match(error.message, /browser helper is not available/i);
    assert.doesNotMatch(error.message, new RegExp(HELPER_TOKEN));
    assert.deepEqual(harness.requests, []);
  });
});

test('ft library share exposes stable JSON and unlisted visibility controls', async () => {
  await withShareContext(async ({ filePath, harness }) => {
    const library = buildCli().commands.find((command) => command.name() === 'library');
    const share = library?.commands.find((command) => command.name() === 'share');
    assert.ok(share, 'library share command should be registered');
    assert.deepEqual(share.options.map((option) => option.long), [
      '--visibility',
      '--json',
    ]);

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
    try {
      await buildCli().parseAsync(['node', 'ft', 'library', 'share', filePath, '--visibility', 'unlisted', '--json']);
    } finally {
      console.log = originalLog;
    }

    const result = JSON.parse(logs.join('\n')) as Record<string, unknown>;
    assert.equal(result.path, filePath);
    assert.equal(result.slug, 'morning-edition-a1b2c3');
    assert.equal(result.url, `${harness.baseUrl}/morning-edition-a1b2c3`);
    assert.equal(result.visibility, 'unlisted');
    assert.equal(result.verified, true);
  });
});
