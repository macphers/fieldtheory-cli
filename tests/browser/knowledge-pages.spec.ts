import { expect, test, type Page, type Route } from '@playwright/test';

const transcript = [
  { id: 'segment-opening', startMs: 0, endMs: 60_000, text: 'The opening establishes the central question and why it matters.' },
  { id: 'segment-mechanism', startMs: 60_000, endMs: 120_000, text: 'The middle explains the practical mechanism with a concrete example.' },
  { id: 'segment-ending', startMs: 120_000, endMs: 180_000, text: 'The ending summarizes the tradeoff and proposes a next step.' },
];

const sourceRefs = [{ bookmarkId: 'bookmark-1', bookmarkUrl: 'https://x.com/example/status/1', sourceUrl: 'https://www.youtube.com/watch?v=fixtureReady1', discoveredAt: '2026-08-13T00:00:00.000Z' }];
const baseItem = {
  type: 'youtube', creator: 'Fixture Channel', durationMs: 180_000, sourceRefs, createdAt: '2026-08-13T00:00:00.000Z', updatedAt: '2026-08-13T00:00:00.000Z', language: 'en', note: null,
};
const readyItem = {
  ...baseItem, canonicalId: 'youtube:fixtureReady1', videoId: 'fixtureReady1', canonicalUrl: 'https://www.youtube.com/watch?v=fixtureReady1', title: 'A Prepared Test Conversation', status: 'ready', jobs: [],
  chapters: [
    { startMs: 0, endMs: 60_000, label: 'The question', source: 'creator' },
    { startMs: 60_000, endMs: 120_000, label: 'The mechanism', source: 'creator' },
    { startMs: 120_000, endMs: 180_000, label: 'The next step', source: 'creator' },
  ],
  overview: [
    { text: 'The conversation begins with a focused central question.', citations: [{ startMs: 0, endMs: 60_000, segmentIds: ['segment-opening'], transcriptContentHash: 'fixture' }] },
    { text: 'A concrete example explains the proposed mechanism.', citations: [{ startMs: 60_000, endMs: 120_000, segmentIds: ['segment-mechanism'], transcriptContentHash: 'fixture' }] },
    { text: 'The conclusion identifies a tradeoff and next step.', citations: [{ startMs: 120_000, endMs: 180_000, segmentIds: ['segment-ending'], transcriptContentHash: 'fixture' }] },
  ],
  details: [{ text: 'The practical mechanism appears in the middle section.', citations: [{ startMs: 60_000, endMs: 120_000, segmentIds: ['segment-mechanism'], transcriptContentHash: 'fixture' }] }],
};
const processingItem = {
  ...baseItem, canonicalId: 'youtube:fixtureProcess', videoId: 'fixtureProcess', canonicalUrl: 'https://www.youtube.com/watch?v=fixtureProcess', title: 'A Video Being Prepared', status: 'processing', chapters: [], overview: [], details: [],
  jobs: [{ id: 'job-processing', itemId: 'youtube:fixtureProcess', stage: 'summary', state: 'running', attemptCount: 1 }],
};
const blockedItem = {
  ...baseItem, canonicalId: 'youtube:fixtureBlocked', videoId: 'fixtureBlocked', canonicalUrl: 'https://www.youtube.com/watch?v=fixtureBlocked', title: 'A Video Needing Attention', status: 'blocked', chapters: [], overview: [], details: [],
  jobs: [{ id: 'job-blocked', itemId: 'youtube:fixtureBlocked', stage: 'transcript', state: 'blocked', attemptCount: 1, lastErrorCode: 'binary_missing', lastErrorDetail: 'whisper.cpp is not installed.' }],
};
const items = [readyItem, processingItem, blockedItem];

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function mockApi(page: Page) {
  await page.route('https://www.youtube-nocookie.com/**', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Fixture player</title>' }));
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/v1/items') return json(route, { data: items, pagination: { count: items.length } });
    if (url.pathname === '/api/v1/search') return json(route, { data: [{ item: readyItem, matchType: 'transcript', excerpt: transcript[1].text, rank: -1, segmentId: transcript[1].id, startMs: transcript[1].startMs, endMs: transcript[1].endMs }], query: url.searchParams.get('q') });
    if (url.pathname === '/api/v1/session') return json(route, { csrf: 'fixture-csrf' });
    if (url.pathname.endsWith('/transcript')) return json(route, { contentHash: 'fixture', language: 'en', data: transcript, nextCursor: null });
    if (url.pathname.endsWith('/note') && request.method() === 'PUT') return json(route, { markdown: 'Remember this mechanism.', version: 1 });
    if (url.pathname.endsWith('/chat') && request.method() === 'POST') return json(route, { answer: 'The mechanism uses a concrete example.', citations: [{ segmentId: 'segment-mechanism', startMs: 60_000, endMs: 120_000 }], refused: false });
    if (url.pathname.endsWith('/activity')) return json(route, { recorded: true }, 201);
    if (url.pathname.endsWith('/cancel') || url.pathname.endsWith('/retry') || url.pathname.endsWith('/transcription-override')) return json(route, { state: 'queued' });
    const match = url.pathname.match(/^\/api\/v1\/items\/(.+)$/);
    if (match) {
      const id = decodeURIComponent(match[1]);
      const item = items.find((candidate) => candidate.canonicalId === id);
      return item ? json(route, item) : json(route, { message: 'Not found' }, 404);
    }
    return json(route, { message: `Unhandled fixture endpoint: ${url.pathname}` }, 500);
  });
}

async function loadLibrary(page: Page, width: number, height: number) {
  await page.setViewportSize({ width, height });
  await mockApi(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Saved understanding' })).toBeVisible();
}

async function openItem(page: Page, title: string) {
  await page.getByRole('button', { name: new RegExp(title) }).click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
}

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(overflow.scroll, `horizontal overflow: ${overflow.scroll}px > ${overflow.client}px`).toBeLessThanOrEqual(overflow.client + 1);
}

async function expectMobileTargets(page: Page) {
  const issues = await page.locator('button:visible, input:visible, textarea:visible').evaluateAll((elements) => elements.flatMap((element) => {
    const rect = element.getBoundingClientRect();
    const label = element.getAttribute('aria-label') || element.textContent?.trim() || element.tagName;
    return rect.width < 24 || rect.height < 24 ? [`${label}: ${Math.round(rect.width)}x${Math.round(rect.height)}`] : [];
  }));
  expect(issues, `undersized touch targets:\n${issues.join('\n')}`).toEqual([]);
}

async function expectVisibleKeyboardFocus(page: Page) {
  await page.keyboard.press('Tab');
  const focused = page.locator(':focus');
  await expect(focused).toBeVisible();
  const visible = await focused.evaluate((element) => {
    const style = getComputedStyle(element);
    return parseFloat(style.outlineWidth) > 0 || style.boxShadow !== 'none' || style.backgroundColor !== 'rgba(0, 0, 0, 0)';
  });
  expect(visible, 'focused control must have a visible focus treatment').toBe(true);
}

function watchConsole(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

test('01 library renders the production bundle on desktop', async ({ page }) => {
  const errors = watchConsole(page); await loadLibrary(page, 1440, 1000);
  await expect(page.getByRole('button', { name: /A Prepared Test Conversation/ })).toBeVisible();
  await expectNoHorizontalOverflow(page); expect(errors).toEqual([]);
});

test('02 library is touch-safe and keyboard-visible on mobile', async ({ page }) => {
  await loadLibrary(page, 390, 844); await expectNoHorizontalOverflow(page); await expectMobileTargets(page); await expectVisibleKeyboardFocus(page);
});

test('03 ready item renders source and synthesis on desktop', async ({ page }) => {
  await loadLibrary(page, 1440, 1000); await openItem(page, readyItem.title);
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible(); await expect(page.getByTitle(readyItem.title)).toBeVisible(); await expectNoHorizontalOverflow(page);
});

test('04 ready item remains responsive on mobile', async ({ page }) => {
  await loadLibrary(page, 390, 844); await openItem(page, readyItem.title); await expectNoHorizontalOverflow(page); await expectMobileTargets(page);
});

test('05 transcript navigation works on desktop', async ({ page }) => {
  await loadLibrary(page, 1280, 900); await openItem(page, readyItem.title); await page.getByRole('tab', { name: 'Transcript' }).click();
  await expect(page.getByRole('button', { name: /The middle explains/ })).toBeVisible(); await page.getByRole('button', { name: /The middle explains/ }).click();
});

test('06 transcript navigation is touch-safe on mobile', async ({ page }) => {
  await loadLibrary(page, 375, 812); await openItem(page, readyItem.title); await page.getByRole('tab', { name: 'Transcript' }).click(); await expectMobileTargets(page); await expectNoHorizontalOverflow(page);
});

test('07 notes save from the desktop document', async ({ page }) => {
  await loadLibrary(page, 1366, 900); await openItem(page, readyItem.title); await page.getByLabel('Notes').fill('Remember this mechanism.'); await page.getByRole('button', { name: 'Save note' }).click(); await expect(page.getByText('Saved', { exact: true })).toBeVisible();
});

test('08 notes are keyboard reachable on mobile', async ({ page }) => {
  await loadLibrary(page, 390, 844); await openItem(page, readyItem.title); await page.getByLabel('Notes').focus(); await expect(page.getByLabel('Notes')).toBeFocused(); await page.getByLabel('Notes').fill('Mobile note'); await expectNoHorizontalOverflow(page);
});

test('09 grounded chat renders a cited answer', async ({ page }) => {
  await loadLibrary(page, 1440, 1000); await openItem(page, readyItem.title); await page.getByLabel('Ask about this video').fill('What is the mechanism?'); await page.getByRole('button', { name: 'Ask' }).click();
  const answer = page.locator('section').filter({ hasText: 'AnswerThe mechanism uses a concrete example.' });
  await expect(answer.getByText('The mechanism uses a concrete example.')).toBeVisible(); await expect(answer.getByRole('button', { name: 'Seek to 1:00' })).toBeVisible();
});

test('10 processing state keeps the page readable and cancellable', async ({ page }) => {
  await loadLibrary(page, 1280, 900); await openItem(page, processingItem.title); await expect(page.getByRole('status')).toContainText('Preparing summary'); await expect(page.getByRole('button', { name: 'Cancel' })).toBeVisible(); await expect(page.getByLabel('Ask about this video')).toBeDisabled();
});

test('11 blocked state is actionable and responsive on mobile', async ({ page }) => {
  await loadLibrary(page, 390, 844); await openItem(page, blockedItem.title); await expect(page.getByRole('status')).toContainText('whisper.cpp is not installed'); await expect(page.getByRole('status')).toContainText('ft app doctor'); await expect(page.getByRole('button', { name: 'Retry' })).toHaveCount(0); await expectMobileTargets(page); await expectNoHorizontalOverflow(page);
});

test('12 source tabs support arrow-key navigation', async ({ page }) => {
  await loadLibrary(page, 1280, 900); await openItem(page, readyItem.title);
  const chapters = page.getByRole('tab', { name: 'Chapters' });
  const transcriptTab = page.getByRole('tab', { name: 'Transcript' });
  await chapters.focus();
  await page.keyboard.press('ArrowRight');
  await expect(transcriptTab).toBeFocused();
  await expect(transcriptTab).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowLeft');
  await expect(chapters).toBeFocused();
  await expect(chapters).toHaveAttribute('aria-selected', 'true');
});

test('13 note conflicts preserve the draft and explain recovery', async ({ page }) => {
  await loadLibrary(page, 1366, 900);
  await page.route('**/api/v1/items/*/note', (route) => json(route, { code: 'note_conflict', message: 'version conflict', action: 'Reload.' }, 409));
  await openItem(page, readyItem.title);
  const note = page.getByLabel('Notes');
  await note.fill('Keep this unsaved draft.');
  await page.getByRole('button', { name: 'Save note' }).click();
  await expect(page.getByText(/A newer note exists.*draft is preserved/)).toBeVisible();
  await expect(note).toHaveValue('Keep this unsaved draft.');
});

test('14 library search opens the matching transcript segment', async ({ page }) => {
  await loadLibrary(page, 1280, 900);
  await page.getByLabel('Search saved videos').fill('mechanism');
  const result = page.getByRole('button', { name: /1:00.*A Prepared Test Conversation.*practical mechanism/ });
  await expect(result).toBeVisible();
  await result.click();
  await expect(page.getByRole('tab', { name: 'Transcript' })).toHaveAttribute('aria-selected', 'true');
  const matchingSegment = page.getByRole('button', { name: /1:00.*practical mechanism/ });
  await expect(matchingSegment).toHaveClass(/search-match/);
  await expect(matchingSegment).toHaveAttribute('aria-current', 'true');
  await expect(matchingSegment).toBeFocused();
});
