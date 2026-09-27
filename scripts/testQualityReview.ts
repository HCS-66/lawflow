import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const fixtureDir = resolve('tmp/recognition-quality-review-fixture');
mkdirSync(fixtureDir, { recursive: true });
execFileSync('python3', ['-c', `
import sys,json
from pathlib import Path
sys.path.insert(0,'scripts')
from buildQualityReview import HTML
values=['001234567890','某甲','示例银行','2026-01-01','2026-01-01','OUT','10.00','90.00','账户转账','某乙','6222000000000001','']
data={'runId':'isolated-browser-fixture','documents':[{'id':'01','label':'核对样例','complete':True,'rows':[{'id':'E1','number':1,'values':values,'pages':[1]}],'issues':[{'id':'I1','field':'counterpartyAccount','message':'两个读取结果的账号不同','severity':'REQUIRED','rows':['E1']}],'images':{'1':'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="100" height="100"%3E%3Crect width="100" height="100" fill="white"/%3E%3C/svg%3E'}},{'id':'02','label':'未完成样例','complete':False,'rows':[],'issues':[],'images':{}}]}
data['documents'].append({'id':'03','label':'多笔同源问题','complete':True,'rows':[{'id':'E1','number':1,'values':values,'pages':[]},{'id':'E2','number':2,'values':values,'pages':[]}],'issues':[{'id':'SHARED','field':'accountNumber','message':'同一页眉影响两笔，请分别确认','severity':'REQUIRED','rows':['E1','E2']}],'images':{}})
Path('tmp/recognition-quality-review-fixture/index.html').write_text(HTML.replace('__PAYLOAD__',json.dumps(data,ensure_ascii=False).replace('<','\\\\u003c')))
`]);
const server = createServer((_request, response) => {
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.end(readFileSync(resolve(fixtureDir, 'index.html')));
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert.ok(address && typeof address !== 'string');
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => ['127.0.0.1', ''].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
  await page.goto(`http://127.0.0.1:${address.port}`);
  await page.getByRole('heading', { name: /流水 1/ }).waitFor();
  assert.equal(await page.getByRole('button', { name: '导出已确认CSV' }).isDisabled(), true);
  await page.getByLabel('对方账号', { exact: true }).fill('6222000000000002');
  await page.getByLabel('核对人').fill('测试核对人');
  await page.locator('.issue input').check();
  await page.getByRole('button', { name: '保存本笔核对' }).click();
  assert.equal(await page.getByRole('button', { name: '导出已确认CSV' }).isDisabled(), false);
  assert.equal(await page.evaluate(() => JSON.parse(document.getElementById('payload')!.textContent!).documents[0].rows[0].values[10]), '6222000000000001');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出已确认CSV' }).click();
  const exported = await download;
  await exported.saveAs(resolve(fixtureDir, 'reviewed.csv'));
  const csv = readFileSync(resolve(fixtureDir, 'reviewed.csv'), 'utf8');
  assert.ok(csv.includes('6222000000000002'));
  assert.equal(csv.split('\r\n')[0].split(',').length, 12);
  await page.reload();
  assert.equal(await page.getByRole('button', { name: '导出已确认CSV' }).isDisabled(), false);
  await page.getByLabel('筛选流水').selectOption('all');
  await page.getByRole('button', { name: '保留为无法确认' }).click();
  assert.equal(await page.getByRole('button', { name: '导出已确认CSV' }).isDisabled(), true);
  await page.getByLabel('选择材料').selectOption('02');
  assert.equal(await page.getByRole('button', { name: '导出已确认CSV' }).isDisabled(), true);
  await page.getByLabel('选择材料').selectOption('03');
  await page.getByLabel('筛选流水').selectOption('pending');
  await page.getByLabel('核对人').fill('测试核对人');
  await page.locator('.issue input').check();
  await page.getByRole('button', { name: '保存本笔核对' }).click();
  assert.equal(await page.getByRole('button', { name: '导出已确认CSV' }).isDisabled(), true, 'one row review cannot clear the other affected transaction');
  assert.ok((await page.locator('#stats').textContent())?.includes('1 笔待确认'));
  assert.deepEqual(errors, []);
  console.log('Quality review browser checks passed: field edit, original preservation, reload, CSV, unresolved and incomplete gates.');
} finally {
  await browser?.close();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
