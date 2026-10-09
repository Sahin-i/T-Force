/** Read-only checks against the running app, including the user's reported file. */
import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { WorkspaceFile } from '../../shared/types.js';

test('the actual running app previews the reported essay and existing five file formats', async ({ page, request }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const files: WorkspaceFile[] = await request.get('/api/files').then(response => response.json());
  expect(files.length).toBeGreaterThan(0);
  await page.goto('/');
  await expect(page.getByText('Ready to work', { exact: true })).toBeVisible();
  if (!await page.getByRole('searchbox', { name: 'Search workspace files' }).isVisible()) await page.getByRole('button', { name: 'Show workspace', exact: true }).click();
  const essay = files.find(file => file.name === 'essay_on_curiosity.docx');
  expect(essay, 'The exact file reported by the user must still exist.').toBeTruthy();
  const selected = [essay!, ...['xlsx', 'pdf', 'png', 'csv'].map(extension => files.find(file => file.name.endsWith(`.${extension}`))!)];
  expect(selected.every(Boolean), 'Existing acceptance inputs cover DOCX, XLSX, PDF, PNG, and CSV.').toBeTruthy();
  for (const file of selected) {
    await page.getByRole('searchbox', { name: 'Search workspace files' }).fill(file.path);
    await page.locator('.workspace-file-open').filter({ has: page.getByText(file.name, { exact: true }) }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    if (file.name.endsWith('.docx')) {
      const body = page.frameLocator(`iframe[title="Document preview: ${file.name}"]`).locator('body');
      await expect(body).toContainText(/curiosity/i);
      await expect(body.locator('section')).not.toHaveCount(0);
      const parsed = await promisify(execFile)('docker', ['run', '--rm', '--network', 'none', '--read-only', '--mount', `type=bind,source=${path.resolve('workspace')},target=/workspace,readonly`, 'office-agent-sandbox:local', 'python', '-c', 'import sys,json; from docx import Document; d=Document(sys.argv[1]); print(json.dumps([p.text for p in d.paragraphs if p.text.strip()]+[c.text for t in d.tables for r in t.rows for c in r.cells if c.text.strip()]))', `/workspace/${file.path}`], { maxBuffer: 1024 * 1024 });
      const paragraphs: string[] = JSON.parse(parsed.stdout);
      for (const paragraph of paragraphs) await expect(body).toContainText(paragraph);
    } else if (file.name.endsWith('.xlsx')) {
      await expect(page.getByRole('dialog').getByRole('table')).toBeVisible();
      await expect(page.getByRole('dialog').getByRole('tab')).not.toHaveCount(0);
    } else if (file.name.endsWith('.pdf')) {
      await expect(page.getByRole('dialog').getByRole('img', { name: /^PDF page/ })).toBeVisible();
      await expect(page.locator('.pdf-page-scroll')).toHaveAttribute('aria-busy', 'false');
      expect(await page.locator('.pdf-page canvas').evaluate(element => (element as HTMLCanvasElement).width)).toBeGreaterThan(0);
    } else if (file.name.endsWith('.png')) {
      await expect(page.getByRole('dialog').getByRole('img', { name: file.name })).toBeVisible();
      expect(await page.getByRole('dialog').getByRole('img', { name: file.name }).evaluate(element => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    } else await expect(page.locator('.text-preview')).not.toHaveText('');
    await expect(page.getByRole('alert')).toHaveCount(0);
    // Independent local bytes compared to bytes downloaded through the browser.
    const original = await readFile(path.resolve('workspace', file.path));
    const downloadEvent = page.waitForEvent('download');
    await page.getByRole('dialog').getByRole('link', { name: 'Download', exact: true }).click();
    const downloaded = await downloadEvent;
    expect(downloaded.suggestedFilename()).toBe(file.name);
    expect(await readFile((await downloaded.path())!)).toEqual(original);
    await page.screenshot({ path: test.info().outputPath(`actual-${file.name}.png`) });
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
  }
  expect(errors).toEqual([]);
});
