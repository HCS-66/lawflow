import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';

const root = resolve('.');
const server = createServer((request, response) => {
  try {
    const path = realpathSync(resolve(root, '.' + decodeURIComponent(new URL(request.url || '/', 'http://localhost').pathname)));
    const ext = extname(path);
    if (!path.startsWith(root + sep) || !['.html', '.jpg'].includes(ext)) throw new Error('Unsupported path');
    response.setHeader('Content-Type', ext === '.html' ? 'text/html; charset=utf-8' : 'image/jpeg');
    response.end(readFileSync(path));
  } catch { response.writeHead(404); response.end(); }
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address(); assert.ok(address && typeof address !== 'string');
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const page = await browser.newPage({ viewport: { width: 1480, height: 1080 } });
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  await page.goto(`http://127.0.0.1:${address.port}/output/recognition-quality-review/index.html`);
  await page.getByLabel('选择材料').selectOption('02');
  await page.locator('img.page').waitFor();
  await page.waitForFunction(() => Array.from(document.images).every(image => image.complete && image.naturalWidth > 0));
  assert.equal(await page.getByRole('button', { name: '导出已确认CSV' }).isDisabled(), true);
  assert.equal(await page.locator('#document option').count(), 10);
  assert.ok((await page.locator('#stats').textContent())?.includes('431 笔'));
  assert.deepEqual(errors, []);
  await page.screenshot({ path: resolve('output/recognition-quality-review/preview.png'), fullPage: true });
  console.log('Frozen real-data workspace verified locally: 10 documents, 431-row statement, whole-page images and final-export gate. No edits or network uploads.');
} finally {
  await browser?.close();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
