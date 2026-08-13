import type { KnowledgeItem, TranscriptSegment } from './types';

let csrfToken: string | null = null;

async function responseJson<T>(response: Response): Promise<T> {
  const body = await response.json() as T & { message?: string };
  if (!response.ok) throw new Error(body.message ?? `Request failed with HTTP ${response.status}.`);
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

export async function getItem(id: string): Promise<KnowledgeItem> {
  return responseJson(await fetch(`/api/v1/items/${encodeURIComponent(id)}`, { credentials: 'same-origin' }));
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
