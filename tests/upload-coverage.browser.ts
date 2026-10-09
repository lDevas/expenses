// Real-browser coverage regression; the API uses an isolated in-memory database.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { serve } from '@hono/node-server';
import { createServer } from 'vite';
import puppeteer from 'puppeteer';
import { createApp } from '../server/server.ts';
import { consolidate } from '../server/ingestion/consolidation.ts';
import { date, setup, statement, txn } from './fixtures.ts';
import type { AccountUploadCoverage } from '../src/types/models.ts';

process.env.TZ = 'America/Montevideo';
const { sql, q } = setup();
const savings = statement('savings');
savings.account = { ...savings.account, type: 'savings', name: 'Savings account',
  periodFrom: date('2026-08-27'), periodTo: date('2026-08-27'), periodSource: 'activity' };
savings.transactions = [txn('savings', { date: date('2026-08-27') })];
const card = statement('card');
card.account = { ...card.account, type: 'credit', name: 'Credit card',
  periodFrom: date('2026-08-15'), periodTo: date('2026-09-14') };
card.transactions = [txn('card', { date: date('2026-08-27'), amount: 45 })];
const statements = [savings, card];
q.saveConsolidation(consolidate(statements), statements);
// Recreate an existing savings upload to exercise read-time normalization too.
sql.prepare("UPDATE account_upload_files SET min_date = '2026-08-27', max_date = '2026-08-27' WHERE account_id = 'savings'").run();
const app = createApp(q);
const api = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
if (!api.listening) await once(api, 'listening');
const address = api.address();
assert.ok(address && typeof address !== 'string');
const vite = await createServer({ server: { host: '127.0.0.1', port: 0,
  proxy: { '/api': { target: `http://127.0.0.1:${address.port}` } } }, logLevel: 'silent' });
let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
try {
  const response = await app.request('/api/accounts/upload-ranges');
  assert.equal(response.status, 200);
  const coverage = await response.json() as AccountUploadCoverage[];
  assert.equal(coverage.find(account => account.accountId === 'savings')!.accountType, 'savings');
  assert.equal(coverage.find(account => account.accountId === 'savings')!.maxDate, '2026-08-31');
  assert.equal(coverage.find(account => account.accountId === 'card')!.maxDate, '2026-09-14');

  await vite.listen();
  const origin = vite.resolvedUrls!.local[0].replace(/\/$/, '');
  browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  await page.emulateTimezone('America/Montevideo');
  await page.setViewport({ width: 1440, height: 1100 });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.goto(`${origin}/ingest`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.coverage-account');
  assert.match(await page.$eval('#coverage-heading + span', el => el.textContent!), /2 accounts/);
  assert.match(await page.$eval('[aria-labelledby="coverage-heading"] > .coverage-explanation', el => el.textContent!),
    /Savings uploads cover full calendar months; other accounts use statement periods or activity dates/);

  const accounts = await page.$$('.coverage-account');
  assert.equal(accounts.length, 2);
  for (const account of accounts) {
    const isSavings = (await account.$eval('h3', el => el.textContent!)).includes('Savings account');
    const meta = await account.$eval('.coverage-meta', el => el.textContent!);
    const track = await account.$eval('.coverage-track', el => el.getAttribute('aria-label')!);
    const segment = await account.$eval('.coverage-segment.covered', el => el.getAttribute('title')!);
    const note = await account.$('.coverage-note');
    await account.$eval('.coverage-files', el => { (el as HTMLDetailsElement).open = true; });
    const cells = await account.$$eval('.coverage-files tbody tr td', els => els.map(el => el.textContent));
    if (isSavings) {
      assert.match(meta, /Uploaded through Aug 31, 2026/);
      assert.match(track, /Aug 1, 2026 to Aug 31, 2026/);
      assert.equal(segment, 'Uploaded: Aug 1, 2026 – Aug 31, 2026');
      assert.equal(await note!.evaluate(el => el.textContent),
        'Savings uploads cover full calendar months, including days with no activity.');
      assert.equal(cells[1], 'Aug 1, 2026 – Aug 31, 2026');
      assert.equal(cells[2], 'Full calendar months');
      assert.doesNotMatch(await account.evaluate(el => el.textContent!), /Gaps may reflect days with no activity/);
    } else {
      assert.match(meta, /Uploaded through Sep 14, 2026/);
      assert.match(track, /Aug 15, 2026 to Sep 14, 2026/);
      assert.equal(segment, 'Uploaded: Aug 15, 2026 – Sep 14, 2026');
      assert.equal(note, null);
      assert.equal(cells[1], 'Aug 15, 2026 – Sep 14, 2026');
      assert.equal(cells[2], 'Statement period');
    }
  }
  await mkdir('.context', { recursive: true });
  await page.screenshot({ path: '.context/upload-coverage.png', fullPage: true });
  assert.deepEqual(errors, []);
  console.log('Browser passed: existing savings uploads show full August coverage; credit-card periods remain exact.');
} finally {
  await browser?.close();
  await vite.close();
  await new Promise<void>((resolve, reject) => api.close(error => error ? reject(error) : resolve()));
  sql.close();
}
