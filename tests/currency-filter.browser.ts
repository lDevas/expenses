// Currency-filter regression check against an isolated in-memory API.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { serve } from '@hono/node-server';
import { createServer } from 'vite';
import puppeteer from 'puppeteer';
import { createApp } from '../server/server.ts';
import { consolidate } from '../server/ingestion/consolidation.ts';
import { setup, statement, txn } from './fixtures.ts';

process.env.TZ = 'America/Montevideo';
const { sql, q } = setup();
const day = new Date(2026, 8, 30, 12);
const statements = [
  statement('bank', { transactions: [
    txn('bank', { date: day, description: 'Local purchase', amount: -20 }),
    txn('bank', { date: day, description: 'Local salary', kind: 'other', amount: 100 }),
  ] }),
  statement('savings', { transactions: [
    txn('savings', { date: day, description: 'Savings purchase', amount: -40 }),
  ] }),
];
const result = consolidate(statements);
result.exchanges.push({ id: 'test-fx', matchStatus: 'matched', accountId: 'bank', accountLabel: 'Bank',
  date: day, fromCurrency: 'UYU', toCurrency: 'USD', fromAmount: 40000, toAmount: 1000,
  impliedRate: 0.025, sourceFiles: [] });
q.saveConsolidation(result, statements);
for (const [currency, amount, category, description] of [
  ['USD', 12, 'income', 'Foreign dollar income'],
  ['EUR', -15, 'expense', 'Foreign euro purchase'],
  ['ARS', -900, 'expense', 'Foreign peso purchase'],
] as const) {
  q.saveTransaction({ id: `currency-${currency}`, accountId: 'bank', category, amount, currency,
    date: day, description, source: 'manual-entry', importedAt: new Date() });
}
const api = serve({ fetch: createApp(q).fetch, hostname: '127.0.0.1', port: 0 });
if (!api.listening) await once(api, 'listening');
const address = api.address();
assert.ok(address && typeof address !== 'string');
const vite = await createServer({ server: { host: '127.0.0.1', port: 0,
  proxy: { '/api': { target: `http://127.0.0.1:${address.port}` } } }, logLevel: 'silent' });
let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
try {
  await vite.listen();
  const origin = vite.resolvedUrls!.local[0].replace(/\/$/, '');
  browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1100 });
  await page.emulateTimezone('America/Montevideo');
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.evaluateOnNewDocument(() => {
    const RealDate = Date;
    window.Date = new Proxy(RealDate, {
      construct(target, args) { return Reflect.construct(target, args.length ? args : ['2026-10-07T15:00:00Z']); },
      get(target, key) { return key === 'now' ? () => new RealDate('2026-10-07T15:00:00Z').getTime() : Reflect.get(target, key); },
    });
  });
  const period = '.filter-bar select[name="period"]';
  const account = '.filter-bar select[name="account"]';
  const currency = '.filter-bar select[name="currency"]';
  for (const route of ['/details', '/']) {
    await page.goto(`${origin}${route}`, { waitUntil: 'networkidle0' });
    assert.equal(await page.$eval(currency, s => (s as HTMLSelectElement).value), '');
    await page.select(period, '2026-09');
    await page.waitForFunction(() => document.querySelector('.balance-card')?.textContent?.includes('(EUR)'));
    await page.select(currency, 'USD');
    await page.waitForFunction(() => !document.querySelector('.balance-card')?.textContent?.includes('(UYU)'));
    const balance = await page.$eval('.balance-card', el => el.textContent!);
    assert.match(balance, /12\.00/);
    assert.match(balance, /15\.00/);
    assert.match(balance, /900\.00/);
    assert.doesNotMatch(balance, /NaN/);
    if (route === '/details') {
      const rows = await page.$eval('.table-wrap tbody', el => el.textContent!);
      for (const description of ['Foreign dollar income', 'Foreign euro purchase', 'Foreign peso purchase']) assert.ok(rows.includes(description));
      assert.doesNotMatch(rows, /Local|Savings|UYU/);
      assert.match(await page.$eval('.details-scroll-status', el => el.textContent!), /Showing 3 of 3/);
      await page.screenshot({ path: '.context/currency-filter-details.png' });
    } else {
      const charts = await page.$$eval('.chart-panel', els => els.map(el => el.textContent).join(' '));
      assert.match(charts, /15\.00/);
      assert.match(charts, /900\.00/);
      assert.doesNotMatch(charts, /UYU|NaN/);
      await page.screenshot({ path: '.context/currency-filter.png' });
    }
    await page.select(account, 'savings');
    await page.waitForFunction(() => document.querySelector('main')?.textContent?.includes('No transactions in this period'));
    assert.equal(await page.$eval(currency, s => (s as HTMLSelectElement).value), 'USD');
    await page.select(account, 'bank');
    await page.waitForFunction(() => document.querySelector('.balance-card')?.textContent?.includes('15.00'));
    await page.select(period, '2026-08');
    await page.waitForFunction(() => document.querySelector('main')?.textContent?.includes('No transactions in this period'));
    assert.equal(await page.$eval(currency, s => (s as HTMLSelectElement).value), 'USD');
    await page.select(period, '2026-09');
    await page.select(currency, 'UYU');
    await page.waitForFunction(() => document.querySelector('.balance-card')?.textContent?.includes('80.00'));
    assert.doesNotMatch(await page.$eval('.balance-card', el => el.textContent!), /\((USD|EUR|ARS)\)/);
    if (route === '/details') {
      assert.match(await page.$eval('.table-wrap tbody', el => el.textContent!), /Local purchase/);
      assert.doesNotMatch(await page.$eval('.table-wrap tbody', el => el.textContent!), /Foreign/);
    }
    await page.select(currency, '');
    await page.waitForFunction(() => document.querySelector('.balance-card')?.textContent?.includes('(EUR)'));
  }
  assert.deepEqual(errors, []);
  console.log('Currency browser passed: Dashboard/Details, foreign grouping, original-currency totals/charts and combined account/period filters.');
} finally {
  await browser?.close();
  await vite.close();
  await new Promise<void>((resolve, reject) => api.close(error => error ? reject(error) : resolve()));
  sql.close();
}
