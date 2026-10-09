import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import type { Run, WorkspaceFile } from '../../shared/types.js';

const browserErrors = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => { const errors: string[] = []; browserErrors.set(page, errors); page.on('pageerror', error => errors.push(error.message)); });

async function openApp(page: Page) {
  await page.goto('/');
  await expect(page.getByText('Ready to work', { exact: true })).toBeVisible();
}
async function newChat(page: Page) {
  const created = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/chats');
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  const chat: { id: string } = await (await created).json();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('office.selected-chat'))).toBe(chat.id);
  await expect(page.getByRole('heading', { name: 'What are we working on?' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Message T-force' })).toBeEmpty();
}
async function send(page: Page, text: string) {
  await newChat(page);
  await page.getByRole('textbox', { name: 'Message T-force' }).fill(text);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
}
async function completed(page: Page) {
  await expect(page.locator('.assistant-message').last()).toHaveAttribute('aria-busy', 'false');
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeVisible();
}
async function preview(page: Page, name: string) {
  if (!await page.getByRole('searchbox', { name: 'Search workspace files' }).isVisible()) await page.getByRole('button', { name: 'Show workspace', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Search workspace files' }).fill(name);
  await page.locator('.workspace-file-open').filter({ has: page.getByText(name, { exact: true }) }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
}

test.afterEach(async ({ page, request }) => {
  // A failed assertion must not leave the isolated harness busy for later tests.
  const health = await request.get('/api/health').then(response => response.json());
  if (health.activeRun) await request.post(`/api/runs/${health.activeRun.id}/abort`);
  expect(browserErrors.get(page) ?? [], 'No uncaught browser errors').toEqual([]);
});

test('restores persisted history, switches chats, preserves independent drafts, and reloads selection', async ({ page }) => {
  await openApp(page);
  await page.getByRole('button', { name: 'E2E existing history', exact: true }).click();
  await expect(page.getByText('Restored history fixture.', { exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: 'Message T-force' }).fill('Draft in history');
  await newChat(page);
  await page.getByRole('textbox', { name: 'Message T-force' }).fill('Draft in new chat');
  await page.getByRole('button', { name: 'E2E existing history', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Message T-force' })).toHaveValue('Draft in history');
  await page.reload();
  await expect(page.getByText('Restored history fixture.', { exact: true })).toBeVisible();
  await expect(page.locator('.chat-item.selected')).toHaveText('E2E existing history');
});

test('renders streamed Markdown, usage, elapsed time, and safe links; reload does not resubmit', async ({ page, request }) => {
  await openApp(page);
  await send(page, 'E2E markdown');
  await completed(page);
  await expect(page.getByRole('heading', { name: 'Verified result' })).toBeVisible();
  await expect(page.locator('.markdown strong')).toHaveText('Bold text');
  await expect(page.locator('.markdown table')).toContainText('42');
  await expect(page.getByRole('link', { name: 'External reference' })).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(page.getByRole('link', { name: 'Unsafe' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Missing file' })).toHaveCount(0);
  await expect(page.locator('.message-meta')).toContainText('30 tokens');
  const before = await request.get('/api/e2e/observability').then(response => response.json());
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Verified result' })).toBeVisible();
  const after = await request.get('/api/e2e/observability').then(response => response.json());
  expect(after.runs.length).toBe(before.runs.length);
});

test('rapid Enter presses submit one message and Shift+Enter creates a newline', async ({ page, request }) => {
  await openApp(page); await newChat(page);
  const editor = page.getByRole('textbox', { name: 'Message T-force' });
  await editor.fill('First line'); await editor.press('Shift+Enter');
  await expect(editor).toHaveValue('First line\n');
  await editor.fill('E2E rapid submission');
  const before: { runs: Run[] } = await request.get('/api/e2e/observability').then(response => response.json());
  let submissions = 0;
  page.on('request', request => { if (request.method() === 'POST' && /\/api\/chats\/[^/]+\/messages$/.test(request.url())) submissions++; });
  await editor.evaluate(element => { element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
  await completed(page);
  await expect(page.locator('.user-message')).toHaveCount(1);
  const after: { runs: Run[] } = await request.get('/api/e2e/observability').then(response => response.json());
  expect(after.runs.length).toBe(before.runs.length + 1);
  expect(submissions).toBe(1);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('rapid New conversation clicks create one chat', async ({ page, request }) => {
  await openApp(page);
  const before: unknown[] = await request.get('/api/chats').then(response => response.json());
  let creations = 0;
  page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/chats') creations++; });
  const created = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/chats');
  await page.locator('.new-chat-button').evaluate(element => { element.dispatchEvent(new MouseEvent('click', { bubbles: true })); element.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  const chat: { id: string } = await (await created).json();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('office.selected-chat'))).toBe(chat.id);
  const after: unknown[] = await request.get('/api/chats').then(response => response.json());
  expect(after.length).toBe(before.length + 1);
  expect(creations).toBe(1);
});

test('uploads with picker, keeps duplicate names separate, removes draft attachment, and downloads exact bytes', async ({ page, request }) => {
  await openApp(page);
  await newChat(page);
  const bytes = Buffer.from('name,value\nBakı,42\n');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Attach files', exact: true }).click();
  await (await chooser).setFiles([{ name: 'e2e-upload.csv', mimeType: 'text/csv', buffer: bytes }, { name: 'e2e-upload.csv', mimeType: 'text/csv', buffer: bytes }]);
  await expect(page.locator('.attachment-chip')).toHaveCount(2);
  const files: WorkspaceFile[] = await request.get('/api/files').then(response => response.json());
  const uploaded = files.filter(file => file.name === 'e2e-upload.csv');
  expect(uploaded).toHaveLength(2);
  expect(new Set(uploaded.map(file => file.path)).size).toBe(2);
  for (const file of uploaded) {
    const download = await request.get(`/api/files/download?path=${encodeURIComponent(file.path)}`);
    expect(download.ok()).toBeTruthy(); expect(await download.body()).toEqual(bytes);
  }
  await page.getByRole('button', { name: 'Remove e2e-upload.csv', exact: true }).first().click();
  await expect(page.locator('.attachment-chip')).toHaveCount(1);
  await page.getByRole('textbox', { name: 'Message T-force' }).fill('E2E attachment inspection');
  await page.getByRole('button', { name: 'Send message' }).click();
  await completed(page);
  await expect(page.locator('.sent-attachments a')).toHaveCount(1);
  await page.locator('.tool-group > summary').click();
  await page.locator('.tool-item > summary').click();
  await expect(page.locator('.tool-details')).toContainText('Bakı');
});

test('uploads through drag and drop, rejects oversized files, and preserves accepted draft', async ({ page }) => {
  await openApp(page); await newChat(page);
  const transfer = await page.evaluateHandle(() => { const data = new DataTransfer(); data.items.add(new File(['Dropped fixture'], 'e2e-dropped.txt', { type: 'text/plain' })); return data; });
  await page.locator('.main-panel').dispatchEvent('dragenter', { dataTransfer: transfer });
  await expect(page.getByText('Drop your files here', { exact: true })).toBeVisible();
  await page.locator('.main-panel').dispatchEvent('drop', { dataTransfer: transfer });
  await expect(page.locator('.attachment-chip')).toContainText('e2e-dropped.txt');
  await page.locator('input[type=file]').setInputFiles({ name: 'e2e-too-large.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(25 * 1024 * 1024 + 1) });
  await expect(page.getByRole('alert')).toContainText('Each file must be 25.0 MB or smaller.');
  await expect(page.locator('.attachment-chip')).toHaveCount(1);
  await page.getByRole('button', { name: 'Dismiss error' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('previews Unicode text, empty text, and truncated text; keyboard focus stays in the dialog', async ({ page }) => {
  await openApp(page);
  await preview(page, 'e2e-text.txt');
  await expect(page.locator('.text-preview')).toContainText('Bakı ✓');
  await expect(page.getByRole('button', { name: 'Close preview' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('dialog').getByRole('link', { name: 'Download', exact: true })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByRole('button', { name: 'Close preview' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.workspace-file-open').filter({ hasText: 'e2e-text.txt' })).toBeFocused();
  await preview(page, 'e2e-empty.txt');
  await expect(page.locator('.text-preview')).toHaveText('');
  await page.keyboard.press('Escape');
  await preview(page, 'e2e-long.txt');
  await expect(page.locator('.preview-truncated')).toBeVisible();
});

test('previews raster image pixels and downloads through the UI', async ({ page, request }) => {
  await openApp(page); await preview(page, 'e2e-image.png');
  const image = page.getByRole('dialog').getByRole('img', { name: 'e2e-image.png' });
  await expect(image).toBeVisible();
  expect(await image.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(240);
  const original = await request.get('/api/files/download?path=outputs%2Fe2e-image.png').then(response => response.body());
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('dialog').getByRole('link', { name: 'Download', exact: true }).click();
  const downloaded = await downloadEvent;
  expect(downloaded.suggestedFilename()).toBe('e2e-image.png');
  expect(await readFile((await downloaded.path())!)).toEqual(original);
});

test('renders PDF canvas, changes pages and zoom, and releases preview on close', async ({ page }) => {
  await openApp(page); await preview(page, 'e2e-reference.pdf');
  await expect(page.getByRole('img', { name: 'PDF page 1 of 2' })).toBeVisible();
  await expect(page.locator('.pdf-page-scroll')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('.pdf-page .sr-only')).toHaveText('E2E first PDF page');
  const nonwhite = await page.locator('.pdf-page canvas').evaluate(element => { const canvas = element as HTMLCanvasElement; const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data; let count = 0; for (let i = 0; i < data.length; i += 4) if (data[i] < 240 && data[i + 1] < 240 && data[i + 2] < 240) count++; return count; });
  expect(nonwhite).toBeGreaterThan(100);
  await page.getByRole('button', { name: 'Next PDF page' }).click();
  await expect(page.getByRole('img', { name: 'PDF page 2 of 2' })).toBeVisible();
  await expect(page.locator('.pdf-page .sr-only')).toHaveText('E2E second PDF page');
  await page.getByRole('button', { name: 'Zoom in PDF' }).click();
  await expect(page.locator('.pdf-zoom')).toHaveText('125%');
  await page.getByRole('button', { name: 'Previous PDF page' }).click();
  await expect(page.locator('.pdf-page .sr-only')).toHaveText('E2E first PDF page');
  await page.getByRole('button', { name: 'Close preview' }).click();
  await expect(page.locator('.pdf-page canvas')).toHaveCount(0);
});

test('previews DOCX paragraphs and table content', async ({ page }) => {
  await openApp(page); await preview(page, 'e2e-document.docx');
  const document = page.frameLocator('iframe[title="Document preview: e2e-document.docx"]').locator('body');
  await expect(document).toContainText('E2E DOCX heading');
  await expect(document).toContainText('E2E document body with Bakı and Unicode ✓.');
  await expect(document).toContainText('Document cell');
  await expect(document).toContainText('E2E second document page');
  await expect(document.locator('section.office-docx')).toHaveCount(2);
  await expect(document.locator('img')).toBeVisible();
  expect(await document.locator('img').evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(240);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await preview(page, 'e2e-document.docx');
  await expect(document).toContainText('E2E DOCX heading');
  await document.getByText('E2E DOCX heading', { exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('previews workbook sheets and formula text, and parses quoted multiline CSV', async ({ page }) => {
  await openApp(page); await preview(page, 'e2e-workbook.xlsx');
  await expect(page.getByRole('dialog')).toContainText('Alpha');
  await page.getByRole('dialog').getByTitle(/^B4: =SUM\(B2:B3\)/).click();
  await expect(page.locator('.workbook-formula')).toContainText('=SUM(B2:B3)');
  await expect(page.getByTitle(/^B4: =SUM\(B2:B3\)/)).toHaveText('15');
  await expect(page.getByTitle('C2: 12.5%', { exact: true })).toBeVisible();
  await expect(page.getByTitle('C3: $1,234.50', { exact: true })).toBeVisible();
  await expect(page.getByTitle('D2: Merged label', { exact: true }).locator('..')).toHaveAttribute('colspan', '2');
  await expect(page.locator('.office-preview-note')).toContainText('Showing the first 200 rows');
  await expect(page.getByRole('dialog')).toContainText('Inputs');
  await expect(page.getByRole('dialog')).toContainText('Other sheet');
  await page.getByRole('dialog').getByRole('tab', { name: 'Other sheet', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Another sheet');
  await expect(page.getByRole('table', { name: 'Other sheet worksheet' })).toBeVisible();
  await page.getByRole('tab', { name: 'Inputs', exact: true }).click();
  await expect(page.getByRole('table', { name: 'Inputs worksheet' })).toContainText('Alpha');
  await page.keyboard.press('Escape');
  await preview(page, 'e2e-table.csv');
  await expect(page.getByRole('dialog')).toContainText('Comma, name');
  await expect(page.getByRole('dialog')).toContainText(/Line\s*break/);
});

test('unsupported or corrupt files show a usable error with download', async ({ page }) => {
  await openApp(page); await preview(page, 'e2e-binary.bin');
  await expect(page.getByText('Preview is not available for this file format.', { exact: true })).toBeVisible();
  await expect(page.getByRole('dialog').getByRole('link', { name: 'Download file', exact: true })).toBeVisible();
  await page.keyboard.press('Escape'); await preview(page, 'e2e-broken.docx');
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('dialog').getByRole('link', { name: 'Download file', exact: true })).toBeVisible();
});

test('runs actual Docker tools, keeps them collapsed, surfaces generated artifacts, and refreshes workspace', async ({ page, request }) => {
  await openApp(page); await send(page, 'E2E create artifact'); await completed(page);
  await expect(page.locator('.tool-group')).not.toHaveAttribute('open', '');
  await expect(page.locator('.artifact-card')).toContainText('e2e-created.txt');
  await page.locator('.tool-group > summary').click();
  await page.locator('.tool-item > summary').click();
  await expect(page.locator('.tool-details')).toContainText('Created by actual Docker tool');
  await page.locator('.artifact-open').click();
  await expect(page.locator('.text-preview')).toHaveText('Created by actual Docker tool\n');
  await page.keyboard.press('Escape');
  await page.getByRole('searchbox', { name: 'Search workspace files' }).fill('e2e-created.txt');
  await page.getByRole('button', { name: 'Refresh workspace files' }).click();
  await expect(page.locator('.workspace-file-open')).toContainText('e2e-created.txt');
  const bytes = await request.get('/api/files/download?path=outputs%2Fe2e-created.txt').then(response => response.body());
  expect(bytes.toString()).toBe('Created by actual Docker tool\n');
});

test('busy state follows the run across chats; Stop cancels the model and preserves the other draft', async ({ page, request }) => {
  await openApp(page); await send(page, 'E2E slow model');
  await expect(page.getByText('Slow stream started.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'E2E existing history', exact: true }).click();
  await expect(page.getByText('Another conversation is working in the shared workspace.', { exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: 'Message T-force' }).fill('Another draft preserved');
  await expect(page.getByRole('button', { name: 'Send message' })).toBeDisabled();
  await page.getByRole('button', { name: 'View run' }).click();
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.getByText('Stopped. Files already written remain in the workspace.', { exact: true })).toBeVisible();
  await completed(page);
  const observed: { runs: Run[] } = await request.get('/api/e2e/observability').then(response => response.json());
  expect(observed.runs.at(-1)?.status).toBe('stopped');
  await page.getByRole('button', { name: 'E2E existing history', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Message T-force' })).toHaveValue('Another draft preserved');
});

test('Stop removes the real Docker tool container before delayed file writes', async ({ page, request }) => {
  await openApp(page); await send(page, 'E2E tool cancellation');
  await expect(page.locator('.tool-group > summary')).toContainText('Running a command');
  await page.locator('.tool-group > summary').click(); await page.locator('.tool-item > summary').click();
  await expect(page.locator('.tool-details')).toContainText('E2E-command-started');
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await completed(page);
  const observed: { runs: Run[]; files: WorkspaceFile[] } = await request.get('/api/e2e/observability').then(response => response.json());
  expect(observed.runs.at(-1)?.status).toBe('stopped');
  expect(observed.files.some(file => file.name === 'e2e-late-write.txt')).toBeFalsy();
});

test('refresh reconnects to the existing stream without duplicate output or submission', async ({ page, request }) => {
  await openApp(page); await send(page, 'E2E reconnect');
  await expect(page.locator('.assistant-message .markdown')).toContainText('E2E');
  const before: { runs: Run[] } = await request.get('/api/e2e/observability').then(response => response.json());
  await page.reload();
  await completed(page);
  await expect(page.locator('.assistant-message .markdown')).toHaveText('E2E streamed message completed exactly once.');
  const after: { runs: Run[] } = await request.get('/api/e2e/observability').then(response => response.json());
  expect(after.runs.length).toBe(before.runs.length);
  await expect(page.locator('.user-message')).toHaveCount(1);
});

test('network interruption replays missed stream events once', async ({ page, request }) => {
  await openApp(page); await send(page, 'E2E reconnect network');
  await expect(page.locator('.assistant-message .markdown')).toContainText('E2E');
  const disconnected = await request.post('/api/e2e/disconnect-streams').then(response => response.json());
  expect(disconnected.disconnected).toBe(1);
  await expect(page.getByText('Reconnecting…', { exact: true })).toBeVisible();
  await completed(page);
  await expect(page.locator('.assistant-message .markdown')).toHaveText('E2E streamed message completed exactly once.');
  await expect(page.locator('.user-message')).toHaveCount(1);
});

test('model errors remain readable after reload and allow a subsequent new chat', async ({ page }) => {
  await openApp(page); await send(page, 'E2E provider failure'); await completed(page);
  await expect(page.getByRole('alert')).toContainText('The deterministic model failed before producing output.');
  await page.reload();
  await expect(page.getByRole('alert')).toContainText('The deterministic model failed before producing output.');
  await send(page, 'E2E after failure'); await completed(page);
  await expect(page.locator('.assistant-message .markdown')).toHaveText('E2E streamed message completed exactly once.');
});

test('mobile layout opens conversations and workspace without horizontal page overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openApp(page);
  await expect(page.getByRole('searchbox', { name: 'Search workspace files' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Open conversations' }).click();
  await page.getByRole('button', { name: 'E2E existing history', exact: true }).click();
  await expect(page.getByText('Restored history fixture.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Close conversation sidebar' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Show workspace', exact: true }).click();
  await expect(page.getByRole('searchbox', { name: 'Search workspace files' })).toBeVisible();
  await preview(page, 'e2e-text.txt');
  await expect(page.locator('.text-preview')).toContainText('Bakı ✓');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Close workspace' }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
});

test('file APIs reject traversal, missing paths, and unsafe origins without exposing local files', async ({ request }) => {
  for (const filePath of ['../package.json', '/etc/passwd', 'outputs/../../.env', 'outputs/missing.txt']) {
    const response = await request.get(`/api/files/download?path=${encodeURIComponent(filePath)}`);
    expect(response.status()).toBeGreaterThanOrEqual(400);
    const body = await response.json(); expect(typeof body.message).toBe('string');
    expect(JSON.stringify(body)).not.toContain('AZURE_OPENAI_API_KEY');
  }
  const untrusted = await request.post('/api/chats', { headers: { Origin: 'https://evil.example' }, data: {} });
  expect(untrusted.status()).toBe(403);
});
