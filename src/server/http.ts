import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ContentRepository } from '../content/repository.js';
import type { ProcessingStage } from '../jobs/state-machine.js';
import { ConfirmationChallenges, LocalCapabilitySessions, parseCookies } from './security.js';

const REQUIRED_STAGES: readonly ProcessingStage[] = ['metadata', 'transcript', 'chapters', 'summary'];
const requiredStages = (item: { type: string }): readonly ProcessingStage[] => item.type === 'article' ? ['chapters', 'summary'] : REQUIRED_STAGES;
const MAX_BODY_BYTES = 1024 * 1024;

interface ApiErrorBody {
  code: string;
  message: string;
  retryable: boolean;
  action: string;
  details?: unknown;
}

export interface ContentServerOptions {
  repository: ContentRepository;
  host?: '127.0.0.1';
  port?: number;
  bootstrapTtlMs?: number;
  sessionTtlMs?: number;
  now?: () => number;
  staticDir?: string;
  chat?: { answer(itemId: string, question: string, signal?: AbortSignal): Promise<{ answer: string; citations: Array<{ segmentId: string; startMs: number; endMs: number }>; refused: boolean }> };
  cancelJob?: (jobId: string) => Promise<void>;
}

export interface RunningContentServer {
  origin: string;
  bootstrapUrl: string;
  close(): Promise<void>;
}

function securityHeaders(response: ServerResponse): void {
  // YouTube embeds require the embedding origin (Error 153 otherwise). The
  // bootstrap capability is removed by a redirect before this document loads,
  // so sending only the origin cross-site does not expose its token or path.
  response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:; media-src https:; frame-src https://www.youtube.com https://www.youtube-nocookie.com; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
}

function json(response: ServerResponse, status: number, value: unknown): void {
  securityHeaders(response);
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(value));
}

function apiError(response: ServerResponse, status: number, body: ApiErrorBody): void {
  json(response, status, body);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += value.length;
    if (length > MAX_BODY_BYTES) throw new Error('request_body_too_large');
    chunks.push(value);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function pathItemId(pathname: string, suffix = ''): string | null {
  const pattern = suffix
    ? new RegExp(`^/api/v1/items/([^/]+)/${suffix}$`)
    : /^\/api\/v1\/items\/([^/]+)$/;
  const match = pathname.match(pattern);
  if (!match) return null;
  try { return decodeURIComponent(match[1]); } catch { return null; }
}

function integerQuery(value: string | null, fallback: number, minimum: number, maximum: number): number | null {
  if (value === null) return fallback;
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return null;
  return Math.min(maximum, Math.max(minimum, parsed));
}

export async function startContentServer(options: ContentServerOptions): Promise<RunningContentServer> {
  const host = options.host ?? '127.0.0.1';
  const sessions = new LocalCapabilitySessions();
  const challenges = new ConfirmationChallenges();
  const now = options.now ?? Date.now;
  let expectedHost = '';
  let origin = '';
  const staticDir = path.resolve(options.staticDir ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web'));

  const server = http.createServer(async (request, response) => {
    try {
      securityHeaders(response);
      if (request.headers.host !== expectedHost) {
        return apiError(response, 400, { code: 'invalid_host', message: 'Request Host does not match the loopback server.', retryable: false, action: 'Open Field Theory using the URL printed by `ft app`.' });
      }
      if (request.headers.forwarded || request.headers['x-forwarded-for'] || request.headers['x-forwarded-host'] || request.headers['x-forwarded-proto']) {
        return apiError(response, 400, { code: 'forwarded_request_rejected', message: 'Forwarded requests are not accepted by the local server.', retryable: false, action: 'Connect directly to the loopback URL.' });
      }
      const url = new URL(request.url ?? '/', origin);
      if (request.method === 'GET' && url.pathname === '/bootstrap') {
        const sessionTtlMs = options.sessionTtlMs ?? 12 * 60 * 60_000;
        const session = sessions.exchangeBootstrap(url.searchParams.get('token'), now(), sessionTtlMs);
        if (!session) return apiError(response, 401, { code: 'invalid_bootstrap_token', message: 'The launch token is invalid, expired, or already used.', retryable: false, action: 'Run `ft app` again to create a fresh launch URL.' });
        response.statusCode = 303;
        response.setHeader('Set-Cookie', `ft_session=${encodeURIComponent(session.id)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.max(0, Math.floor(sessionTtlMs / 1_000))}`);
        response.setHeader('Location', '/');
        response.end();
        return;
      }

      const session = sessions.authenticate(parseCookies(request.headers.cookie).ft_session, now());
      if (!session) return apiError(response, 401, { code: 'authentication_required', message: 'The local Field Theory session is missing or expired.', retryable: false, action: 'Run `ft app` to open a new authenticated session.' });
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        if (request.headers.origin !== origin) return apiError(response, 403, { code: 'invalid_origin', message: 'State-changing requests must originate from this loopback application.', retryable: false, action: 'Use the Field Theory interface opened by `ft app`.' });
        if (!sessions.verifyCsrf(session, request.headers['x-fieldtheory-csrf'] as string | undefined)) {
          return apiError(response, 403, { code: 'csrf_required', message: 'The CSRF token is missing or invalid.', retryable: false, action: 'Reload the Field Theory interface and try again.' });
        }
      }

      if (request.method === 'GET' && url.pathname === '/') {
        response.statusCode = 200;
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        try { response.end(await readFile(path.join(staticDir, 'index.html'))); }
        catch { response.end('<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="strict-origin-when-cross-origin"><title>Field Theory</title></head><body><main id="root"><p>Field Theory web assets are not built. Run <code>npm run build:web</code>.</p></main></body></html>'); }
        return;
      }
      if (request.method === 'GET' && url.pathname.startsWith('/assets/')) {
        const assetPath = path.resolve(staticDir, `.${url.pathname}`);
        if (!assetPath.startsWith(`${staticDir}${path.sep}`)) return apiError(response, 404, { code: 'asset_not_found', message: 'The requested asset does not exist.', retryable: false, action: 'Rebuild the Field Theory web assets.' });
        try {
          const extension = path.extname(assetPath);
          response.statusCode = 200;
          response.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          response.setHeader('Content-Type', extension === '.js' ? 'text/javascript; charset=utf-8' : extension === '.css' ? 'text/css; charset=utf-8' : 'application/octet-stream');
          response.end(await readFile(assetPath));
        } catch { return apiError(response, 404, { code: 'asset_not_found', message: 'The requested asset does not exist.', retryable: false, action: 'Rebuild the Field Theory web assets.' }); }
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/v1/session') return json(response, 200, { csrf: session.csrf });
      if (request.method === 'GET' && url.pathname === '/api/v1/items') {
        const limit = integerQuery(url.searchParams.get('limit'), 50, 1, 100);
        const offset = integerQuery(url.searchParams.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER);
        if (limit === null || offset === null) return apiError(response, 400, { code: 'invalid_pagination', message: 'Pagination values must be non-negative integers.', retryable: false, action: 'Use integer limit and offset query parameters.' });
        const items = await options.repository.listItems(limit, offset);
        const data = await Promise.all(items.map(async (item) => ({ ...item, status: await options.repository.itemStatus(item.canonicalId, requiredStages(item)) })));
        return json(response, 200, { data, pagination: { limit, offset, count: data.length } });
      }
      if (request.method === 'GET' && url.pathname === '/api/v1/search') {
        const query = url.searchParams.get('q')?.trim() ?? '';
        const limit = integerQuery(url.searchParams.get('limit'), 20, 1, 100);
        if (!query || query.length > 500 || limit === null) return apiError(response, 400, { code: 'invalid_search', message: 'Search requires a query up to 500 characters and an integer limit.', retryable: false, action: 'Enter a shorter search query.' });
        const hits = await options.repository.searchContent(query, limit);
        const statuses = new Map<string, Promise<Awaited<ReturnType<ContentRepository['itemStatus']>>>>();
        const data = await Promise.all(hits.map(async (hit) => {
          let status = statuses.get(hit.item.canonicalId);
          if (!status) {
            status = options.repository.itemStatus(hit.item.canonicalId, requiredStages(hit.item));
            statuses.set(hit.item.canonicalId, status);
          }
          return { ...hit, item: { ...hit.item, status: await status } };
        }));
        return json(response, 200, { data, query });
      }
      const itemId = pathItemId(url.pathname);
      if (request.method === 'GET' && itemId) {
        const item = await options.repository.getItem(itemId);
        if (!item) return apiError(response, 404, { code: 'item_not_found', message: 'The requested content item does not exist.', retryable: false, action: 'Return to the library and select another item.' });
        const [note, jobs, status, chapterRecord, summary] = await Promise.all([
          options.repository.getNote(itemId), options.repository.listJobs(itemId), options.repository.itemStatus(itemId, requiredStages(item)),
          options.repository.getChapters(itemId), options.repository.getSummary(itemId),
        ]);
        return json(response, 200, { ...item, note, jobs, status, chapters: chapterRecord?.chapters ?? [], overview: summary?.overview ?? [], details: summary?.details ?? [] });
      }
      const transcriptItemId = pathItemId(url.pathname, 'transcript');
      if (request.method === 'GET' && transcriptItemId) {
        const record = await options.repository.getTranscript(transcriptItemId);
        if (!record) return apiError(response, 404, { code: 'transcript_not_ready', message: 'The transcript is not available yet.', retryable: true, action: 'Check the item processing status and retry when the transcript stage completes.' });
        const cursor = integerQuery(url.searchParams.get('cursor'), 0, 0, Number.MAX_SAFE_INTEGER);
        const pageSize = integerQuery(url.searchParams.get('limit'), 200, 1, 500);
        if (cursor === null || pageSize === null) return apiError(response, 400, { code: 'invalid_pagination', message: 'Transcript pagination values must be non-negative integers.', retryable: false, action: 'Use integer cursor and limit query parameters.' });
        const data = record.transcript.segments.slice(cursor, cursor + pageSize);
        return json(response, 200, { contentHash: record.transcript.contentHash, language: record.transcript.language, data, nextCursor: cursor + data.length < record.transcript.segments.length ? cursor + data.length : null });
      }
      const relatedItemId = pathItemId(url.pathname, 'related');
      if (request.method === 'GET' && relatedItemId) {
        const limit = integerQuery(url.searchParams.get('limit'), 5, 1, 20);
        if (limit === null) return apiError(response, 400, { code: 'invalid_related_limit', message: 'Related-item limit must be an integer from 1 to 20.', retryable: false, action: 'Use an integer limit between 1 and 20.' });
        if (!await options.repository.getItem(relatedItemId)) return apiError(response, 404, { code: 'item_not_found', message: 'The requested content item does not exist.', retryable: false, action: 'Return to the library and select another item.' });
        const hits = await options.repository.relatedContent(relatedItemId, limit);
        const data = await Promise.all(hits.map(async (hit) => ({ ...hit, item: { ...hit.item, status: await options.repository.itemStatus(hit.item.canonicalId, requiredStages(hit.item)) } })));
        return json(response, 200, { data, method: 'local-tfidf-v1' });
      }
      const noteItemId = pathItemId(url.pathname, 'note');
      if (request.method === 'PUT' && noteItemId) {
        const body = await readJson(request) as { markdown?: unknown; expectedVersion?: unknown };
        if (typeof body.markdown !== 'string' || (body.expectedVersion !== null && !Number.isInteger(body.expectedVersion))) {
          return apiError(response, 400, { code: 'invalid_note', message: 'A note requires Markdown text and an integer expectedVersion (or null).', retryable: false, action: 'Reload the note and submit its current version.' });
        }
        try {
          const note = await options.repository.putNote(noteItemId, body.markdown, body.expectedVersion as number | null, new Date(now()).toISOString());
          return json(response, 200, note);
        } catch (error) {
          if (error instanceof Error && error.message.includes('version conflict')) return apiError(response, 409, { code: 'note_conflict', message: error.message, retryable: true, action: 'Reload the current note, merge your changes, and save again.' });
          throw error;
        }
      }
      if (request.method === 'GET' && url.pathname === '/api/v1/jobs') {
        return json(response, 200, { data: await options.repository.listJobs(url.searchParams.get('itemId') ?? undefined) });
      }
      const retryItemId = pathItemId(url.pathname, 'retry');
      if (request.method === 'POST' && retryItemId) {
        const body = await readJson(request) as { jobId?: unknown };
        if (typeof body.jobId !== 'string') return apiError(response, 400, { code: 'invalid_retry', message: 'Retry requires a jobId.', retryable: false, action: 'Reload job status and select a retryable stage.' });
        const job = (await options.repository.listJobs(retryItemId)).find((candidate) => candidate.id === body.jobId);
        if (!job) return apiError(response, 404, { code: 'job_not_found', message: 'The requested job does not belong to this item.', retryable: false, action: 'Reload the item status.' });
        try { return json(response, 200, await options.repository.retryJob(job.id, new Date(now()).toISOString())); }
        catch (error) { return apiError(response, 409, { code: 'job_not_retryable', message: error instanceof Error ? error.message : String(error), retryable: false, action: 'Wait for active work to finish or retry a failed, blocked, or cancelled stage.' }); }
      }
      const cancelItemId = pathItemId(url.pathname, 'cancel');
      if (request.method === 'POST' && cancelItemId) {
        const body = await readJson(request) as { jobId?: unknown };
        if (typeof body.jobId !== 'string') return apiError(response, 400, { code: 'invalid_cancel', message: 'Cancel requires a jobId.', retryable: false, action: 'Reload job status and select active work.' });
        const job = (await options.repository.listJobs(cancelItemId)).find((candidate) => candidate.id === body.jobId);
        if (!job) return apiError(response, 404, { code: 'job_not_found', message: 'The requested job does not belong to this item.', retryable: false, action: 'Reload the item status.' });
        try {
          if (job.state === 'running' && options.cancelJob) await options.cancelJob(job.id);
          else await options.repository.cancelJob(job.id, new Date(now()).toISOString());
          return json(response, 200, { cancelled: true });
        } catch (error) { return apiError(response, 409, { code: 'job_not_cancellable', message: error instanceof Error ? error.message : String(error), retryable: false, action: 'Reload the current processing state.' }); }
      }
      const overrideItemId = pathItemId(url.pathname, 'transcription-override');
      if (request.method === 'PUT' && overrideItemId) {
        const body = await readJson(request) as { allowLong?: unknown; retryJobId?: unknown };
        if (typeof body.allowLong !== 'boolean' || (body.retryJobId !== undefined && typeof body.retryJobId !== 'string')) {
          return apiError(response, 400, { code: 'invalid_override', message: 'Transcription override requires allowLong:true or false and an optional string retryJobId.', retryable: false, action: 'Confirm the per-item long transcription choice.' });
        }
        const retryJob = typeof body.retryJobId === 'string'
          ? (await options.repository.listJobs(overrideItemId)).find((candidate) => candidate.id === body.retryJobId && candidate.stage === 'transcript')
          : undefined;
        if (body.retryJobId !== undefined && !retryJob) {
          return apiError(response, 404, { code: 'job_not_found', message: 'The requested transcript job does not belong to this item.', retryable: false, action: 'Reload the item processing state.' });
        }
        await options.repository.setLongTranscriptionOverride(overrideItemId, body.allowLong);
        if (body.allowLong && retryJob) await options.repository.retryJob(retryJob.id, new Date(now()).toISOString());
        return json(response, 200, { allowLong: body.allowLong });
      }
      const chatItemId = pathItemId(url.pathname, 'chat');
      if (request.method === 'POST' && chatItemId) {
        if (!options.chat) return apiError(response, 503, { code: 'chat_unavailable', message: 'No synthesis model is configured for item chat.', retryable: true, action: 'Configure a Field Theory model and restart `ft app`.' });
        const body = await readJson(request) as { question?: unknown };
        if (typeof body.question !== 'string' || body.question.trim().length === 0 || body.question.length > 2_000) {
          return apiError(response, 400, { code: 'invalid_question', message: 'Chat requires a question between 1 and 2,000 characters.', retryable: false, action: 'Shorten the question and try again.' });
        }
        const answer = await options.chat.answer(chatItemId, body.question);
        await options.repository.recordActivity({ id: randomUUID(), itemId: chatItemId, type: 'question_asked', metadata: { refused: answer.refused }, createdAt: new Date(now()).toISOString() });
        return json(response, 200, answer);
      }
      if (request.method === 'GET' && url.pathname === '/api/v1/settings/activity') return json(response, 200, { enabled: await options.repository.isActivityEnabled() });
      if (request.method === 'PUT' && url.pathname === '/api/v1/settings/activity') {
        const body = await readJson(request) as { enabled?: unknown };
        if (typeof body.enabled !== 'boolean') return apiError(response, 400, { code: 'invalid_activity_setting', message: 'Activity setting requires enabled:true or enabled:false.', retryable: false, action: 'Submit a boolean enabled value.' });
        await options.repository.setActivityEnabled(body.enabled);
        return json(response, 200, { enabled: body.enabled });
      }
      if (request.method === 'DELETE' && url.pathname === '/api/v1/activity') {
        const body = await readJson(request) as { challenge?: unknown };
        if (typeof body.challenge !== 'string' || !challenges.consume(body.challenge, 'delete_activity', 'all', now())) {
          return json(response, 202, { challenge: challenges.issue('delete_activity', 'all', now()), manifest: { activityEvents: await options.repository.activityCount() } });
        }
        return json(response, 200, { deleted: await options.repository.clearActivity() });
      }
      const activityItemId = pathItemId(url.pathname, 'activity');
      if (request.method === 'POST' && activityItemId) {
        const body = await readJson(request) as { id?: unknown; type?: unknown; metadata?: unknown };
        const allowed = ['item_opened', 'citation_clicked', 'note_saved', 'question_asked'];
        if (typeof body.id !== 'string' || typeof body.type !== 'string' || !allowed.includes(body.type)) {
          return apiError(response, 400, { code: 'invalid_activity', message: 'Activity event type is not allowed.', retryable: false, action: 'Submit one of the documented local activity event types.' });
        }
        const recorded = await options.repository.recordActivity({ id: body.id, itemId: activityItemId, type: body.type as never, metadata: body.metadata as never, createdAt: new Date(now()).toISOString() });
        return json(response, recorded ? 201 : 200, { recorded });
      }
      if (request.method === 'DELETE' && itemId) {
        const manifest = await options.repository.deletionManifest(itemId);
        if (!manifest) return apiError(response, 404, { code: 'item_not_found', message: 'The requested content item does not exist.', retryable: false, action: 'Return to the library.' });
        const body = await readJson(request) as { challenge?: unknown };
        if (typeof body.challenge !== 'string' || !challenges.consume(body.challenge, 'delete_item', itemId, now())) {
          return json(response, 202, { challenge: challenges.issue('delete_item', itemId, now()), manifest });
        }
        return json(response, 200, { deleted: await options.repository.deleteItem(itemId) });
      }

      return apiError(response, 404, { code: 'route_not_found', message: 'The requested local API route does not exist.', retryable: false, action: 'Reload Field Theory or update the CLI.' });
    } catch (error) {
      if (error instanceof SyntaxError) return apiError(response, 400, { code: 'invalid_json', message: 'The request body is not valid JSON.', retryable: false, action: 'Fix the JSON body and retry.' });
      if (error instanceof Error && error.message === 'request_body_too_large') return apiError(response, 413, { code: 'request_too_large', message: 'The request body exceeds 1 MB.', retryable: false, action: 'Reduce the request size.' });
      return apiError(response, 500, { code: 'internal_error', message: 'The local server could not complete the request.', retryable: true, action: 'Retry once, then inspect `ft app doctor` if the problem continues.' });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, host, () => { server.removeListener('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Local content server did not bind to a TCP port.');
  expectedHost = `${host}:${address.port}`;
  origin = `http://${expectedHost}`;
  const bootstrap = sessions.issueBootstrap(now(), options.bootstrapTtlMs ?? 60_000);
  return {
    origin,
    bootstrapUrl: `${origin}/bootstrap?token=${encodeURIComponent(bootstrap)}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}
