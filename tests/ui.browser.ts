// Optional real-browser regression check; all data lives in an in-memory API.
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
const bank = statement('bank', { transactions: [
  txn('bank', { date: new Date(2026, 8, 30, 23, 59, 59), description: 'End-day purchase', amount: -20 }),
  txn('bank', { date: day, description: 'Salary', kind: 'other', amount: 100 }),
  txn('bank', { date: day, description: 'Unmatched card payment', kind: 'card-payment', amount: -5000 }),
  txn('bank', { date: new Date(2026, 9, 1), description: 'Following-day purchase', amount: -900 }),
] });
q.saveConsolidation(consolidate([bank]), [bank]);
for (const [category, amount] of [['internal-transfer', 10000], ['fx-exchange', -4000]] as const) {
  q.saveTransaction({ id: category, accountId: 'bank', category, amount, currency: 'UYU',
    date: day, description: category, source: 'manual-entry', importedAt: new Date() });
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
  await page.emulateTimezone('America/Montevideo');
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.evaluateOnNewDocument(() => {
    const RealDate = Date;
    window.Date = new Proxy(RealDate, {
      construct(target, args) { return Reflect.construct(target, args.length ? args : ['2027-01-15T15:00:00Z']); },
      get(target, key) {
        return key === 'now' ? () => new RealDate('2027-01-15T15:00:00Z').getTime() : Reflect.get(target, key);
      },
    });
  });
  await page.goto(`${origin}/details`, { waitUntil: 'networkidle0' });
  const period = '.filter-bar select';
  assert.equal(await page.$eval(period, s => (s as HTMLSelectElement).value), 'ytd');
  assert.ok((await page.$eval('main', el => el.textContent))!.includes('No transactions in this period'));
  for (const type of ['month', 'quarter', 'year']) {
    await page.select(period, type);
    await page.waitForFunction(() => document.querySelectorAll('.filter-bar select').length === 2);
    const value = await page.$$eval('.filter-bar select', selects => (selects[1] as HTMLSelectElement).value);
    assert.equal(value, type === 'month' ? '2027-01' : type === 'quarter' ? '2027-Q1' : '2027');
    if (type === 'quarter') assert.deepEqual(await page.$$eval('.filter-bar select:nth-of-type(1)', selects =>
      Array.from((selects[1] as HTMLSelectElement).options).map(o => o.value)), ['2026-Q2', '2026-Q3', '2026-Q4', '2027-Q1']);
  }
  async function setCustomRange(from: string, to: string) {
    await page.select(period, 'custom');
    await page.waitForSelector('input[type=date]');
    await page.$$eval('input[type=date]', (inputs, dates) => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      inputs.forEach((input, i) => {
        setValue.call(input, dates[i]);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      });
    }, [from, to]);
  }
  await setCustomRange('2026-09-30', '2026-09-30');
  await page.waitForFunction(() => document.querySelector('tbody')?.textContent?.includes('End-day purchase'));
  assert.ok(!(await page.$eval('tbody', el => el.textContent))!.includes('Following-day purchase'));
  await setCustomRange('2026-09-29', '2026-09-29');
  await page.waitForFunction(() => document.querySelector('main')?.textContent?.includes('No transactions in this period'));
  assert.ok(await page.$(period), 'filters remain available in an empty custom period');

  await page.goto(origin, { waitUntil: 'networkidle0' });
  await setCustomRange('2026-09-30', '2026-09-30');
  await page.waitForSelector('.balance-card');
  const net = await page.$eval('.balance-card', el => el.textContent!);
  assert.match(net, /80\.00/);
  assert.doesNotMatch(net, /5,000|10,000|4,000/);
  const charts = await page.$$eval('.chart-panel', els => els.map(el => el.textContent).join(' '));
  assert.match(charts, /Expenses/);
  assert.match(charts, /20\.00/);
  assert.match(charts, /100\.00/);
  assert.doesNotMatch(charts, /internal-transfer|card-payment|fx-exchange/);
  assert.deepEqual(errors, []);
  console.log('Browser passed: empty-period recovery, period defaults, January quarters, inclusive custom end date, and net-balance movement exclusions.');
} finally {
  await browser?.close();
  await vite.close();
  await new Promise<void>((resolve, reject) => api.close(error => error ? reject(error) : resolve()));
  sql.close();
}
