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
const articleItem = {
  ...baseItem, type: 'article', canonicalId: 'article:x:fixtureArticle', canonicalUrl: 'https://x.com/example/article/fixtureArticle', title: 'A Saved Article About Agency', creator: 'Example Author', durationMs: 240_000, status: 'ready', jobs: [],
  sourceRefs: [{ ...sourceRefs[0], sourceUrl: 'https://x.com/example/article/fixtureArticle' }],
  chapters: [{ startMs: 0, endMs: 180_000, label: 'The central idea', source: 'creator' }], overview: readyItem.overview, details: readyItem.details,
};
const podcastItem = {
  ...baseItem, type: 'podcast', canonicalId: 'podcast:fixtureEpisode', canonicalUrl: 'https://serve.podhome.fm/episodepage/FixtureShow/episode-one', mediaUrl: 'https://cdn.example/episode-one.mp3', title: 'A Saved Podcast About Agency', creator: 'Fixture Host', durationMs: 3_900_000, status: 'ready', jobs: [],
  sourceRefs: [{ ...sourceRefs[0], sourceUrl: 'https://serve.podhome.fm/episodepage/FixtureShow/episode-one' }],
  chapters: readyItem.chapters, overview: readyItem.overview, details: readyItem.details,
};
const items = [readyItem, articleItem, podcastItem, processingItem, blockedItem];
const todayMemories = [{ id: 'memory-ready', kind: 'newly_ready', label: 'Newly ready', title: readyItem.title, whyNow: 'This recent save is ready to skim.', provenance: 'generated', itemId: readyItem.canonicalId, evidence: [{ sourceId: readyItem.canonicalId, sourceTitle: readyItem.title, preview: readyItem.overview[0].text, startMs: 0 }] }];
const topics = [{ id: 'topic-agency', label: 'Agency and useful systems', description: 'How tools preserve human judgment.', confidence: .87, itemCount: 3, recentChange: 'New examples connect infrastructure to agency.' }];
const connections = [{ id: 'connection-agency', fromId: readyItem.canonicalId, fromTitle: readyItem.title, toId: articleItem.canonicalId, toTitle: articleItem.title, relation: 'extends', explanation: 'Both sources connect practical mechanisms to human agency.', confidence: .81, provenance: 'generated', evidence: [{ sourceId: readyItem.canonicalId, sourceTitle: readyItem.title, preview: transcript[1].text }] }];

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function mockApi(page: Page) {
  await page.route('https://www.youtube-nocookie.com/**', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Fixture player</title>' }));
  await page.route('https://cdn.example/**', (route) => route.fulfill({ status: 200, contentType: 'audio/mpeg', body: '' }));
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/v1/memory/today') return json(route, { data: todayMemories });
    if (url.pathname === '/api/v1/memory/topics') return json(route, { data: topics });
    if (url.pathname === '/api/v1/memory/connections') return json(route, { data: connections });
    if (url.pathname === '/api/v1/memory/sync/status') return json(route, { state: 'idle', lastSuccessAt: new Date().toISOString() });
    if (url.pathname === '/api/v1/memory/captures' && request.method() === 'POST') return json(route, { state: 'recognized', message: 'Source recognized and queued.', itemId: readyItem.canonicalId, originalUrl: 'https://example.com/source' });
    if (url.pathname === '/api/v1/memory/corpus/ask' && request.method() === 'POST') return json(route, { answer: 'The library connects mechanisms to agency.', refused: false, partial: false, evidence: [{ sourceId: readyItem.canonicalId, sourceTitle: readyItem.title, preview: transcript[1].text, location: '1:00', reason: 'Directly discusses the mechanism.' }] });
    if (url.pathname.match(/^\/api\/v1\/memory\/[^/]+\/feedback$/)) return json(route, { recorded: true });
    if (url.pathname === '/api/v1/items') return json(route, { data: items, pagination: { count: items.length } });
    if (url.pathname === '/api/v1/search') return json(route, { data: [{ item: readyItem, matchType: 'transcript', excerpt: transcript[1].text, rank: -1, segmentId: transcript[1].id, startMs: transcript[1].startMs, endMs: transcript[1].endMs }], query: url.searchParams.get('q') });
    if (url.pathname.endsWith('/related')) return json(route, { data: [{ item: processingItem, score: 0.42, sharedTerms: ['mechanism', 'concrete example'] }], method: 'local-tfidf-v1' });
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
  await page.goto('/#/library');
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
  await loadLibrary(page, 1280, 900); await openItem(page, processingItem.title); await expect(page.getByRole('status')).toContainText('Preparing summary'); await expect(page.getByRole('button', { name: 'Cancel' })).toBeVisible(); await expect(page.getByLabel('Ask about this video')).toBeEnabled(); await expect(page.getByText('Text is ready.')).toBeVisible();
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
  await page.getByLabel('Search saved sources').fill('mechanism');
  const result = page.getByRole('button', { name: /1:00.*A Prepared Test Conversation.*practical mechanism/ });
  await expect(result).toBeVisible();
  await result.click();
  await expect(page.getByRole('tab', { name: 'Transcript' })).toHaveAttribute('aria-selected', 'true');
  const matchingSegment = page.getByRole('button', { name: /1:00.*practical mechanism/ });
  await expect(matchingSegment).toHaveClass(/search-match/);
  await expect(matchingSegment).toHaveAttribute('aria-current', 'true');
  await expect(matchingSegment).toBeFocused();
});

test('15 related items stay hidden until requested and open the selected page', async ({ page }) => {
  await loadLibrary(page, 1280, 900); await openItem(page, readyItem.title);
  await expect(page.getByText(processingItem.title)).toHaveCount(0);
  await page.getByRole('button', { name: 'Find related' }).click();
  await page.getByRole('button', { name: new RegExp(`${processingItem.title}.*42%`) }).click();
  await expect(page.getByRole('heading', { name: processingItem.title })).toBeVisible();
});

test('16 enriched X articles render as reading pages without a video player', async ({ page }) => {
  await loadLibrary(page, 1280, 900); await openItem(page, articleItem.title);
  await expect(page.getByText('Saved article', { exact: true })).toBeVisible();
  await expect(page.getByText('4 min read')).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Sections' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Article' })).toBeVisible();
  await expect(page.getByTitle(articleItem.title)).toHaveCount(0);
  await expect(page.getByLabel('Ask about this article')).toBeEnabled();
  await expectNoHorizontalOverflow(page);
});

test('17 feed-backed podcasts render responsive audio and transcript controls', async ({ page }) => {
  await loadLibrary(page, 390, 844); await openItem(page, podcastItem.title);
  await expect(page.getByText('Saved podcast', { exact: true })).toBeVisible();
  await expect(page.getByText('65 min')).toBeVisible();
  await expect(page.locator('audio[controls]')).toHaveAttribute('src', podcastItem.mediaUrl);
  await expect(page.getByRole('tab', { name: 'Chapters' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Transcript' })).toBeVisible();
  await expect(page.getByLabel('Ask about this podcast')).toBeEnabled();
  await expectMobileTargets(page); await expectNoHorizontalOverflow(page);
});

test('18 Today is bounded, explainable, and opens source evidence', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 }); await mockApi(page); await page.goto('/');
  await expect(page.getByRole('heading', { name: 'A few useful memories' })).toBeVisible();
  await expect(page.getByText('Why now:')).toBeVisible();
  await expect(page.locator('.memory-card')).toHaveCount(1);
  await page.getByRole('button', { name: 'Open evidence' }).click();
  await expect(page.getByRole('heading', { name: readyItem.title })).toBeVisible();
});

test('19 mobile navigation reaches Topics without the desktop rail', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 }); await mockApi(page); await page.goto('/');
  await page.getByRole('navigation', { name: 'Primary navigation' }).getByRole('link', { name: /Topics/ }).click();
  await expect(page.getByRole('heading', { name: 'Themes in your memory' })).toBeVisible();
  await expect(page.getByRole('heading', { name: topics[0].label })).toBeVisible();
  await expectNoHorizontalOverflow(page); await expectMobileTargets(page);
});

test('20 Connections explains evidence and accepts usefulness feedback', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 }); await mockApi(page); await page.goto('/#/connections');
  await expect(page.getByRole('heading', { name: 'Ideas in conversation' })).toBeVisible();
  await expect(page.getByText(connections[0].explanation)).toBeVisible();
  await page.getByRole('button', { name: 'useful' }).click();
});

test('21 corpus Ask shows a source-and-reason evidence contract', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 }); await mockApi(page); await page.goto('/#/ask');
  await page.getByLabel('Question for your memory').fill('How do these sources connect mechanism and agency?');
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'The library connects mechanisms to agency.' })).toBeVisible();
  await expect(page.getByText('Why retrieved: Directly discusses the mechanism.')).toBeVisible();
});

test('22 Add URL returns a visible capture receipt on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await mockApi(page); await page.goto('/');
  await page.getByRole('button', { name: /Add/ }).click();
  await page.getByLabel('Video, podcast, or article URL').fill('https://example.com/source');
  await page.getByRole('button', { name: 'Add URL', exact: true }).click();
  await expect(page.locator('.capture-receipt')).toContainText('Source recognized and queued.');
  await expectMobileTargets(page); await expectNoHorizontalOverflow(page);
});
