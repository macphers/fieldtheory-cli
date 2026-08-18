import type { CaptureReceipt, ChatAnswer, ContentSearchHit, CorpusAnswer, KnowledgeItem, MemoryConnection, MemoryTopic, RelatedContentHit, SyncHealth, TodayMemory, TranscriptSegment } from './types';

let csrfToken: string | null = null;

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly action?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function responseJson<T>(response: Response): Promise<T> {
  const body = await response.json() as T & { message?: string; code?: string; action?: string };
  if (!response.ok) throw new ApiError(body.message ?? `Request failed with HTTP ${response.status}.`, response.status, body.code, body.action);
  return body;
}

export async function sessionCsrf(): Promise<string> {
  if (csrfToken) return csrfToken;
  const response = await fetch('/api/v1/session', { credentials: 'same-origin' });
  const body = await responseJson<{ csrf: string }>(response);
  csrfToken = body.csrf;
  return body.csrf;
}

export async function listItems(): Promise<KnowledgeItem[]> {
  const response = await fetch('/api/v1/items', { credentials: 'same-origin' });
  return (await responseJson<{ data: KnowledgeItem[] }>(response)).data;
}

export async function searchContent(query: string, limit = 20, signal?: AbortSignal): Promise<ContentSearchHit[]> {
  const params = new URLSearchParams({ q: query, limit: String(limit) });
  const response = await fetch(`/api/v1/search?${params.toString()}`, { credentials: 'same-origin', signal });
  return (await responseJson<{ data: ContentSearchHit[] }>(response)).data;
}

export async function getItem(id: string): Promise<KnowledgeItem> {
  return responseJson(await fetch(`/api/v1/items/${encodeURIComponent(id)}`, { credentials: 'same-origin' }));
}

export async function getRelatedItems(id: string, limit = 5): Promise<RelatedContentHit[]> {
  const response = await fetch(`/api/v1/items/${encodeURIComponent(id)}/related?limit=${limit}`, { credentials: 'same-origin' });
  return (await responseJson<{ data: RelatedContentHit[] }>(response)).data;
}

export async function getTranscript(id: string): Promise<TranscriptSegment[]> {
  const all: TranscriptSegment[] = [];
  let cursor: number | null = 0;
  while (cursor !== null) {
    const response = await fetch(`/api/v1/items/${encodeURIComponent(id)}/transcript?cursor=${cursor}&limit=500`, { credentials: 'same-origin' });
    if (response.status === 404) return [];
    const page = await responseJson<{ data: TranscriptSegment[]; nextCursor: number | null }>(response);
    all.push(...page.data);
    cursor = page.nextCursor;
  }
  return all;
}

export async function saveNote(id: string, markdown: string, expectedVersion: number | null) {
  const csrf = await sessionCsrf();
  return responseJson<{ markdown: string; version: number }>(await fetch(`/api/v1/items/${encodeURIComponent(id)}/note`, {
    method: 'PUT', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-FieldTheory-CSRF': csrf },
    body: JSON.stringify({ markdown, expectedVersion }),
  }));
}

export async function recordActivity(id: string, type: 'item_opened' | 'citation_clicked' | 'note_saved' | 'question_asked', metadata?: Record<string, string | number | boolean>) {
  const csrf = await sessionCsrf();
  await fetch(`/api/v1/items/${encodeURIComponent(id)}/activity`, {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-FieldTheory-CSRF': csrf },
    body: JSON.stringify({ id: crypto.randomUUID(), type, metadata }),
  });
}

export async function askItem(id: string, question: string): Promise<ChatAnswer> {
  const csrf = await sessionCsrf();
  return responseJson(await fetch(`/api/v1/items/${encodeURIComponent(id)}/chat`, {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-FieldTheory-CSRF': csrf },
    body: JSON.stringify({ question }),
  }));
}

async function optionalJson<T>(path: string, init?: RequestInit): Promise<T | null> {
  try {
    const response = await fetch(path, { credentials: 'same-origin', ...init });
    if (!response.ok) return null;
    return await response.json() as T;
  } catch {
    return null;
  }
}

export async function getToday(): Promise<TodayMemory[]> {
  const body = await optionalJson<{ data: TodayMemory[] }>('/api/v1/memory/today');
  return body?.data ?? [];
}

export async function getTopics(): Promise<MemoryTopic[]> {
  const body = await optionalJson<{ data: MemoryTopic[] }>('/api/v1/memory/topics');
  return body?.data ?? [];
}

export async function getConnections(): Promise<MemoryConnection[]> {
  const body = await optionalJson<{ data: MemoryConnection[] }>('/api/v1/memory/connections');
  return body?.data ?? [];
}

export async function getSyncHealth(): Promise<SyncHealth | null> {
  return optionalJson<SyncHealth>('/api/v1/memory/sync/status');
}

export async function addCapture(url: string): Promise<CaptureReceipt> {
  const csrf = await sessionCsrf();
  const response = await fetch('/api/v1/memory/captures', {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-FieldTheory-CSRF': csrf },
    body: JSON.stringify({ url }),
  });
  return responseJson<CaptureReceipt>(response);
}

export async function askCorpus(question: string, scopes: Record<string, string>): Promise<CorpusAnswer | null> {
  const csrf = await sessionCsrf();
  return optionalJson<CorpusAnswer>('/api/v1/memory/corpus/ask', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-FieldTheory-CSRF': csrf }, body: JSON.stringify({ question, scopes }),
  });
}

export async function recordMemoryFeedback(id: string, action: 'keep' | 'dismiss' | 'applied' | 'useful' | 'obvious' | 'wrong'): Promise<boolean> {
  const csrf = await sessionCsrf();
  const result = await optionalJson<{ recorded: boolean }>(`/api/v1/memory/${encodeURIComponent(id)}/feedback`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-FieldTheory-CSRF': csrf }, body: JSON.stringify({ action }),
  });
  return result?.recorded ?? false;
}

async function jobMutation(id: string, action: 'retry' | 'cancel', jobId: string): Promise<void> {
  const csrf = await sessionCsrf();
  await responseJson(await fetch(`/api/v1/items/${encodeURIComponent(id)}/${action}`, {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-FieldTheory-CSRF': csrf },
    body: JSON.stringify({ jobId }),
  }));
}

export function retryJob(id: string, jobId: string): Promise<void> { return jobMutation(id, 'retry', jobId); }
export function cancelJob(id: string, jobId: string): Promise<void> { return jobMutation(id, 'cancel', jobId); }

export async function allowLongTranscription(id: string, retryJobId: string): Promise<void> {
  const csrf = await sessionCsrf();
  await responseJson(await fetch(`/api/v1/items/${encodeURIComponent(id)}/transcription-override`, {
    method: 'PUT', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-FieldTheory-CSRF': csrf },
    body: JSON.stringify({ allowLong: true, retryJobId }),
  }));
}
