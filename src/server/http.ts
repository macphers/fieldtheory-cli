import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { ContentRepository } from '../content/repository.js';
import type { ProcessingStage } from '../jobs/state-machine.js';
import { ConfirmationChallenges, LocalCapabilitySessions, parseCookies } from './security.js';

const REQUIRED_STAGES: readonly ProcessingStage[] = ['metadata', 'transcript', 'chapters', 'summary'];
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
  now?: () => number;
}

export interface RunningContentServer {
  origin: string;
  bootstrapUrl: string;
  close(): Promise<void>;
}

function securityHeaders(response: ServerResponse): void {
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https://i.ytimg.com data:; frame-src https://www.youtube.com https://www.youtube-nocookie.com; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
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
  return match ? decodeURIComponent(match[1]) : null;
}

export async function startContentServer(options: ContentServerOptions): Promise<RunningContentServer> {
  const host = options.host ?? '127.0.0.1';
  const sessions = new LocalCapabilitySessions();
  const challenges = new ConfirmationChallenges();
  const now = options.now ?? Date.now;
  let expectedHost = '';
  let origin = '';

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
        const session = sessions.exchangeBootstrap(url.searchParams.get('token'), now(), options.bootstrapTtlMs ?? 60_000);
        if (!session) return apiError(response, 401, { code: 'invalid_bootstrap_token', message: 'The launch token is invalid, expired, or already used.', retryable: false, action: 'Run `ft app` again to create a fresh launch URL.' });
        response.statusCode = 303;
        response.setHeader('Set-Cookie', `ft_session=${encodeURIComponent(session.id)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`);
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
        response.end(`<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Field Theory</title></head><body><main id="app" data-csrf="${session.csrf}"></main></body></html>`);
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/v1/session') return json(response, 200, { csrf: session.csrf });
      if (request.method === 'GET' && url.pathname === '/api/v1/items') {
        const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') ?? 50)));
        const offset = Math.max(0, Number(url.searchParams.get('offset') ?? 0));
        const items = await options.repository.listItems(limit, offset);
        const data = await Promise.all(items.map(async (item) => ({ ...item, status: await options.repository.itemStatus(item.canonicalId, REQUIRED_STAGES) })));
        return json(response, 200, { data, pagination: { limit, offset, count: data.length } });
      }
      const itemId = pathItemId(url.pathname);
      if (request.method === 'GET' && itemId) {
        const item = await options.repository.getItem(itemId);
        if (!item) return apiError(response, 404, { code: 'item_not_found', message: 'The requested content item does not exist.', retryable: false, action: 'Return to the library and select another item.' });
        const [note, jobs, status] = await Promise.all([options.repository.getNote(itemId), options.repository.listJobs(itemId), options.repository.itemStatus(itemId, REQUIRED_STAGES)]);
        return json(response, 200, { ...item, note, jobs, status });
      }
      const transcriptItemId = pathItemId(url.pathname, 'transcript');
      if (request.method === 'GET' && transcriptItemId) {
        const record = await options.repository.getTranscript(transcriptItemId);
        if (!record) return apiError(response, 404, { code: 'transcript_not_ready', message: 'The transcript is not available yet.', retryable: true, action: 'Check the item processing status and retry when the transcript stage completes.' });
        const cursor = Math.max(0, Number(url.searchParams.get('cursor') ?? 0));
        const pageSize = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') ?? 200)));
        const data = record.transcript.segments.slice(cursor, cursor + pageSize);
        return json(response, 200, { contentHash: record.transcript.contentHash, language: record.transcript.language, data, nextCursor: cursor + data.length < record.transcript.segments.length ? cursor + data.length : null });
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
