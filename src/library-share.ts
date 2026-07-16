import { Agent, fetch as directFetch } from 'undici';
import { readBrowserHelperState, type BrowserHelperState } from './browser-helper-state.js';
import { showLibraryDocument } from './library.js';

export type LibraryShareVisibility = 'unlisted';

export interface LibraryShareOptions {
  visibility?: string;
}

export interface LibraryShareResult {
  path: string;
  slug: string;
  url: string;
  visibility: LibraryShareVisibility;
  verified: boolean;
}

interface ShareDetails {
  slug: string;
  url: string;
  visibility?: 'listed' | 'unlisted';
}

interface ShareDocument {
  path: string;
  content: string;
  title: string;
}

const PUBLIC_READING_ORIGIN = 'https://librarian.fieldtheory.dev';
const PUBLIC_OG_ORIGIN = 'https://fieldtheory-og.vercel.app';

function normalizeLoopbackHost(value: string): string | null {
  const host = value.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' ? host : null;
}

function normalizeHelperState(value: BrowserHelperState | null): BrowserHelperState | null {
  if (!value) return null;
  const host = normalizeLoopbackHost(value.host);
  if (!host) return null;
  return { ...value, host };
}

async function loadHelperState(): Promise<BrowserHelperState> {
  const state = normalizeHelperState(await readBrowserHelperState());
  if (!state) {
    throw new Error('Field Theory browser helper is not available. Start Field Theory, then try again.');
  }
  return state;
}

function helperUrl(state: BrowserHelperState, pathname: string): URL {
  const host = state.host === '::1' ? '[::1]' : state.host;
  return new URL(pathname, `http://${host}:${state.port}`);
}

async function helperJson(
  state: BrowserHelperState,
  pathname: string,
  label: string,
  init: { method?: 'POST'; body?: Record<string, unknown> } = {},
): Promise<Record<string, unknown>> {
  const url = helperUrl(state, pathname);
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'X-FieldTheory-Browser-Token': state.token,
  };
  if (init.body) headers['Content-Type'] = 'application/json';

  const dispatcher = new Agent({ connect: { timeout: 5_000 } });
  try {
    const response = await directFetch(url, {
      method: init.method,
      headers,
      body: init.body ? JSON.stringify(init.body) : undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(5_000),
      dispatcher,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Field Theory browser helper returned HTTP ${response.status} while trying to ${label}.`);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error(`Field Theory browser helper returned malformed JSON while trying to ${label}.`);
    }
    if (!payload || typeof payload !== 'object') {
      throw new Error(`Field Theory browser helper returned a malformed response while trying to ${label}.`);
    }
    return payload as Record<string, unknown>;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Field Theory browser helper')) throw error;
    throw new Error(`Field Theory browser helper is not responding while trying to ${label}.`);
  } finally {
    await dispatcher.close().catch(() => undefined);
  }
}

function readShareDetails(value: unknown): ShareDetails | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (typeof record.slug !== 'string' || record.slug.trim() === '') return null;
  if (typeof record.url !== 'string' || record.url.trim() === '') return null;
  const visibility = record.visibility === 'listed' || record.visibility === 'unlisted'
    ? record.visibility
    : undefined;
  return { slug: record.slug, url: record.url, visibility };
}

function requireUnlisted(details: ShareDetails): asserts details is ShareDetails & { visibility: 'unlisted' } {
  if (details.visibility !== 'unlisted') {
    throw new Error('The installed Field Theory app cannot confirm unlisted sharing. Update Field Theory, then try again.');
  }
}

async function getShareStatus(state: BrowserHelperState, filePath: string): Promise<ShareDetails | null> {
  const url = helperUrl(state, '/native/librarian/share-status');
  url.searchParams.set('path', filePath);
  const payload = await helperJson(state, `${url.pathname}${url.search}`, 'read share status');
  if (payload.ok !== true) {
    throw new Error('Field Theory browser helper returned malformed share status.');
  }
  if (payload.status === null) {
    throw new Error('Field Theory sharing is unavailable. Make sure the app is open and signed in, then try again.');
  }
  if (!payload.status || typeof payload.status !== 'object') {
    throw new Error('Field Theory browser helper returned malformed share status.');
  }
  const status = payload.status as Record<string, unknown>;
  if (status.shared === false) return null;
  if (status.shared !== true) {
    throw new Error('Field Theory browser helper returned malformed share status.');
  }
  const details = readShareDetails(status);
  if (!details) throw new Error('Field Theory browser helper returned malformed share status.');
  return details;
}

async function createShare(
  state: BrowserHelperState,
  filePath: string,
  visibility: LibraryShareVisibility,
): Promise<ShareDetails> {
  let payload: Record<string, unknown>;
  try {
    payload = await helperJson(state, '/native/librarian/share-reading', 'create a shared reading', {
      method: 'POST',
      body: { filePath, visibility },
    });
  } catch (error) {
    try {
      const committed = await getShareStatus(state, filePath);
      if (committed) return committed;
    } catch {
      // Preserve the original transport failure if reconciliation cannot prove success.
    }
    throw error;
  }
  const details = payload.ok === true ? readShareDetails(payload.result) : null;
  if (!details) {
    throw new Error('Field Theory did not create a shared reading. Make sure the app is signed in, then try again.');
  }
  requireUnlisted(details);
  return details;
}

async function updateShareOnce(
  state: BrowserHelperState,
  document: ShareDocument,
  visibility: LibraryShareVisibility,
): Promise<void> {
  const payload = await helperJson(state, '/native/librarian/update-shared-reading', 'update the shared reading', {
    method: 'POST',
    body: {
      filePath: document.path,
      content: document.content,
      title: document.title,
      visibility,
    },
  });
  if (payload.ok !== true || payload.success !== true) {
    throw new Error('Field Theory did not update the shared reading. Make sure the app is signed in, then try again.');
  }
}

async function updateShare(
  state: BrowserHelperState,
  document: ShareDocument,
  visibility: LibraryShareVisibility,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await updateShareOnce(state, document, visibility);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function decodeHtml(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

function normalizedText(value: string): string {
  return decodeHtml(value).replace(/\s+/g, ' ').trim();
}

function htmlAttribute(tag: string, name: string): string | null {
  const match = tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return match ? decodeHtml(match[1] ?? match[2] ?? match[3] ?? '') : null;
}

function ogImageFromHtml(html: string): string | null {
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    if (htmlAttribute(match[0], 'property')?.toLowerCase() !== 'og:image') continue;
    const content = htmlAttribute(match[0], 'content');
    if (content) return content;
  }
  return null;
}

function testPublicOrigin(): string | null {
  const value = process.env.FT_LIBRARY_SHARE_TEST_ORIGIN;
  if (!value) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' && normalizeLoopbackHost(parsed.hostname) ? parsed.origin : null;
  } catch {
    return null;
  }
}

function expectedPublicUrl(slug: string, kind: 'page' | 'OG image'): URL {
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(slug)) {
    throw new Error('The shared reading has a malformed slug.');
  }
  const testOrigin = testPublicOrigin();
  const origin = testOrigin ?? (kind === 'page' ? PUBLIC_READING_ORIGIN : PUBLIC_OG_ORIGIN);
  const pathname = kind === 'page' ? `/${slug}` : `/api/${slug}`;
  return new URL(pathname, origin);
}

function validatePublicUrl(value: string, slug: string, kind: 'page' | 'OG image'): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`The shared reading has a malformed ${kind} URL.`);
  }
  const expected = expectedPublicUrl(slug, kind);
  if (parsed.origin !== expected.origin || parsed.pathname !== expected.pathname || parsed.search || parsed.hash) {
    throw new Error(`The shared reading has an unexpected ${kind} URL.`);
  }
  return parsed;
}

async function fetchPublic(url: URL, label: string): Promise<Response> {
  try {
    return await fetch(url, {
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new Error(`The shared reading ${label} is not reachable.`);
  }
}

async function verifyPublicShareOnce(details: ShareDetails, expectedTitle: string): Promise<void> {
  const pageUrl = validatePublicUrl(details.url, details.slug, 'page');
  const pageResponse = await fetchPublic(pageUrl, 'page');
  if (pageResponse.status !== 200) {
    await pageResponse.body?.cancel();
    throw new Error(`The shared reading page returned HTTP ${pageResponse.status}; expected HTTP 200.`);
  }
  const contentType = pageResponse.headers.get('content-type')?.toLowerCase() ?? '';
  if (!contentType.startsWith('text/html')) {
    await pageResponse.body?.cancel();
    throw new Error(`The shared reading page returned ${contentType || 'no content type'}; expected text/html.`);
  }
  const html = await pageResponse.text();
  const titleMatch = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  const actualTitle = titleMatch ? normalizedText(titleMatch[1]) : '';
  const normalizedExpectedTitle = normalizedText(expectedTitle);
  const titleSuffix = actualTitle.slice(normalizedExpectedTitle.length);
  if (!actualTitle.startsWith(normalizedExpectedTitle) || (titleSuffix && !/^[\s|—–-]/.test(titleSuffix))) {
    throw new Error(`The shared reading page did not contain the expected title: ${expectedTitle}.`);
  }
  const robotsHeader = pageResponse.headers.get('x-robots-tag') ?? '';
  const robotsMeta = [...html.matchAll(/<meta\b[^>]*>/gi)].find((match) => (
    htmlAttribute(match[0], 'name')?.toLowerCase() === 'robots'
  ));
  const robotsContent = robotsMeta ? htmlAttribute(robotsMeta[0], 'content') ?? '' : '';
  if (!/(?:^|[\s,])noindex(?:$|[\s,])/i.test(`${robotsHeader},${robotsContent}`)) {
    throw new Error('The shared reading page is not unlisted; expected a noindex directive.');
  }

  const ogImage = ogImageFromHtml(html);
  if (!ogImage) throw new Error('The shared reading page did not contain an og:image URL.');
  let ogUrl: URL;
  try {
    ogUrl = new URL(ogImage, pageResponse.url || pageUrl);
  } catch {
    throw new Error('The shared reading page contained a malformed og:image URL.');
  }
  const verifiedOgUrl = validatePublicUrl(ogUrl.toString(), details.slug, 'OG image');
  const ogResponse = await fetchPublic(verifiedOgUrl, 'OG image');
  if (ogResponse.status !== 200) {
    await ogResponse.body?.cancel();
    throw new Error(`The shared reading OG image returned HTTP ${ogResponse.status}; expected HTTP 200.`);
  }
  const ogContentType = ogResponse.headers.get('content-type')?.toLowerCase() ?? '';
  if (!ogContentType.startsWith('image/png')) {
    await ogResponse.body?.cancel();
    throw new Error(`The shared reading OG image returned ${ogContentType || 'no content type'}; expected image/png.`);
  }
  await ogResponse.body?.cancel();
}

async function verifyPublicShare(details: ShareDetails, expectedTitle: string): Promise<void> {
  let lastError: unknown;
  for (const delay of [0, 250, 750]) {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    try {
      await verifyPublicShareOnce(details, expectedTitle);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

export async function shareLibraryDocument(
  target: string,
  options: LibraryShareOptions = {},
): Promise<LibraryShareResult> {
  const visibility = options.visibility ?? 'unlisted';
  if (visibility !== 'unlisted') {
    throw new Error(`Unsupported share visibility: ${visibility}. Only unlisted sharing is currently supported.`);
  }

  const document = await showLibraryDocument(target);
  const state = await loadHelperState();
  const existing = await getShareStatus(state, document.path);
  if (existing) {
    await updateShare(state, document, visibility);
  } else {
    await createShare(state, document.path, visibility);
  }

  const details = await getShareStatus(state, document.path);
  if (!details) throw new Error('Field Theory did not persist the shared reading.');
  requireUnlisted(details);

  await verifyPublicShare(details, document.title);
  return {
    path: document.path,
    slug: details.slug,
    url: details.url,
    visibility,
    verified: true,
  };
}
