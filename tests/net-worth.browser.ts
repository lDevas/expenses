// Real-browser net-worth regression using only an in-memory API/database.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { serve } from '@hono/node-server';
import { createServer } from 'vite';
import puppeteer from 'puppeteer';
import { createApp } from '../server/server.ts';
import { consolidate } from '../server/ingestion/consolidation.ts';
import { setup, statement, txn, date } from './fixtures.ts';

process.env.TZ = 'America/Montevideo';
const { sql, q } = setup();

const savings = statement('savings');
savings.kind = 'itau-estado';
savings.account = { ...savings.account, type: 'savings', institutionId: 'itau', institutionName: 'Itau Uruguay' };
savings.account.openingBalance = 10000;
savings.account.closingBalance = 12345;
savings.transactions = [
  txn('savings', { date: date('2026-09-10'), amount: -1000, balanceAfter: 9000 }),
  txn('savings', { date: date('2026-09-20'), amount: 3345, balanceAfter: 12345 }),
];

const ibkr = statement('ibkr');
ibkr.kind = 'ibkr-statement';
ibkr.account = { ...ibkr.account, type: 'investment', currency: 'USD', institutionId: 'ibkr', institutionName: 'Interactive Brokers' };
ibkr.summary = { 'NAV Cash total': 500 };
ibkr.positions = [{ accountId: 'ibkr', symbol: 'AAPL', qty: 10, costBasis: 1500, value: 2000, snapshotDate: date('2026-09-30'), currency: 'USD' }];

q.saveConsolidation(consolidate([savings, ibkr]), [savings, ibkr]);

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
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.evaluateOnNewDocument(() => {
    const RealDate = Date;
    window.Date = new Proxy(RealDate, {
      construct(target, args) { return Reflect.construct(target, args.length ? args : ['2026-10-07T15:00:00Z']); },
      get(target, key) {
        return key === 'now' ? () => new RealDate('2026-10-07T15:00:00Z').getTime() : Reflect.get(target, key);
      },
    });
  });

  // ─── Dashboard: card + two charts, outside the transactions empty state ───
  await page.goto(`${origin}`, { waitUntil: 'networkidle0' });
  const period = '.filter-bar select[name="period"]';
  const account = '.filter-bar select[name="account"]';
  const card = '.net-worth-card';

  await page.waitForSelector(`${card} .balance-value`);
  assert.equal(await page.$eval(`${card} h2`, el => el.textContent), 'Net Worth');
  assert.match(await page.$eval(`${card} .balance-value`, el => el.textContent ?? ''), /UYU[\s\u00A0\u202F]*12,345\.00/);
  assert.match(await page.$eval(`${card} .balance-label`, el => el.textContent!), /as of 2026-09-30/);
  assert.match(await page.$eval(`${card} .balance-warn`, el => el.textContent!), /No FX exchange found/);

  const titles = await page.$$eval('.chart-panel.tone-networth h3', els => els.map(el => el.textContent));
  assert.deepEqual(titles, ['Bank net worth', 'Net worth including investments']);
  // No rate: the combined chart keeps a line per currency and explains it.
  assert.match(await page.$eval('.chart-panel.tone-networth:nth-child(2) .chart-note', el => el.textContent!), /per currency/);
  // The savings account has transactions, so the normal sections render alongside the net-worth section.
  const mainText = await page.$eval('main', el => el.textContent ?? '');
  assert.match(mainText, /Net Balance/);
  assert.doesNotMatch(mainText, /No transactions in this period/);

  // Selecting the savings account keeps the bank net worth unchanged (own kind).
  await page.select(account, 'savings');
  await page.waitForFunction(() => document.querySelector('.net-worth-card .balance-value')?.textContent?.includes('12,345'));
  // Selecting the investment account leaves the bank series unfiltered.
  await page.select(account, 'ibkr');
  await page.waitForFunction(() => document.querySelector('.net-worth-card .balance-value')?.textContent?.includes('12,345'));

  // September alone: same values, and the card still renders with zero-transaction accounts.
  await page.select(account, '');
  await page.select(period, '2026-09');
  await page.waitForFunction(() => document.querySelector('.net-worth-card .balance-value')?.textContent?.includes('12,345'));
  assert.match(await page.$eval(`${card} .balance-label`, el => el.textContent!), /as of 2026-09-30/);

  // A step path is only drawn between adjacent known values, so an isolated
  // observation must be visible as a dot. Without an FX rate the combined
  // chart keeps per-currency lines (not relaid out): the single investment
  // observation is isolated, the continuous bank line is not.
  await page.waitForFunction(
    () => document.querySelectorAll('.chart-panel.tone-networth:nth-child(2) circle.recharts-line-dot').length === 1,
    { timeout: 10000 },
  );
  assert.equal(
    await page.$$eval('.chart-panel.tone-networth:nth-child(1) circle.recharts-line-dot', els => els.length),
    0, 'the continuous bank line draws no dots',
  );
  assert.ok(
    await page.$$eval('.chart-panel.tone-networth:nth-child(2) path.recharts-curve', els => els.length) >= 2,
    'the combined chart draws a curve path per line',
  );
  await page.screenshot({ path: '.context/net-worth-dashboard.png' });

  await page.setViewport({ width: 390, height: 844 });
  // Let the charts re-measure (ResizeObserver + recharts render) before measuring overflow.
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'mobile layout fits the viewport');
  await page.setViewport({ width: 1440, height: 1100 });

  // ─── Details: the same card at the top, above the period summary ───
  await page.goto(`${origin}/details`, { waitUntil: 'networkidle0' });
  await page.select(period, '2026-09');
  await page.waitForSelector(`${card} .balance-value`);
  assert.match(await page.$eval(`${card} .balance-value`, el => el.textContent!), /12,345\.00/);
  assert.match(await page.$eval(`${card} .balance-label`, el => el.textContent!), /as of 2026-09-30/);
  const layout = await page.$$eval('.net-worth-card, .details-summary', els =>
    els.map(el => { const b = el.getBoundingClientRect(); return { top: b.top, bottom: b.bottom }; }));
  assert.ok(layout[1].top >= layout[0].bottom, 'net worth card sits above the period summary');
  await page.screenshot({ path: '.context/net-worth-details.png' });

  // Zero-error run.
  assert.deepEqual(errors, []);
  console.log('Browser passed: net worth card and charts on Dashboard (filter-reactive, account/currency aware, no-FX notes) and the Details top card, with mobile layout.');
} finally {
  await browser?.close();
  await vite.close();
  await new Promise<void>((resolve, reject) => api.close(error => error ? reject(error) : resolve()));
  sql.close();
}
