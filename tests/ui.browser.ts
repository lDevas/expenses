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
const savings = statement('savings', { transactions: [
  txn('savings', { date: day, description: 'Savings purchase', amount: -40 }),
  txn('savings', { date: day, description: 'Savings income', kind: 'other', amount: 200 }),
] });
const inactive = statement('inactive', { transactions: [
  txn('inactive', { date: new Date(2026, 7, 15), description: 'Older purchase', amount: -10 }),
] });
const statements = [bank, savings, inactive];
q.saveConsolidation(consolidate(statements), statements);
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
  const period = '.filter-bar select[name="period"]';
  const account = '.filter-bar select[name="account"]';
  assert.equal(await page.$eval(period, s => (s as HTMLSelectElement).value), 'ytd');
  assert.equal(await page.$eval(account, s => (s as HTMLSelectElement).value), '');
  assert.deepEqual(await page.$eval(account, s => Array.from((s as HTMLSelectElement).options).map(o => o.value).sort()),
    ['', 'bank', 'inactive', 'savings']);
  assert.ok((await page.$eval('main', el => el.textContent))!.includes('No transactions in this period'));
  const periodOptions = await page.$eval(period, select => Array.from((select as HTMLSelectElement).options).map(option => option.value));
  assert.deepEqual(periodOptions, ['ytd', '2027-01', '2026-12', '2026-11', '2026-10', '2026-09', '2026-08', '2026-07', 'year', 'custom']);
  await page.select(period, '2027-01');
  assert.equal(await page.$('select[name="year"]'), null);
  await page.select(period, '2026-09');
  await page.waitForFunction(() => document.querySelector('.table-wrap tbody')?.textContent?.includes('End-day purchase'));
  assert.doesNotMatch(await page.$eval('.table-wrap tbody', el => el.textContent!), /Following-day purchase/);
  await page.select(period, 'year');
  await page.waitForSelector('select[name="year"]');
  assert.equal(await page.$eval('select[name="year"]', s => (s as HTMLSelectElement).value), '2027');

  async function clickDay(date: string) {
    const [year, month] = date.split('-');
    await page.select('.date-range-dialog[open] .rdp-years_dropdown', year);
    await page.select('.date-range-dialog[open] .rdp-months_dropdown', String(Number(month) - 1));
    await page.click(`.date-range-dialog[open] [data-day="${date}"] button`);
  }
  async function setCustomRange(from: string, to: string) {
    await page.select(period, 'custom');
    await page.click('.date-range-trigger');
    await page.waitForSelector('.date-range-dialog[open]');
    await clickDay(from);
    assert.equal(await page.$eval('.date-range-actions .primary', b => (b as HTMLButtonElement).disabled), true);
    await clickDay(to);
    await page.click('.date-range-actions .primary');
    await page.waitForSelector('.date-range-dialog[open]', { hidden: true });
  }
  await setCustomRange('2026-09-30', '2026-09-30');
  await page.waitForFunction(() => document.querySelector('.table-wrap tbody')?.textContent?.includes('End-day purchase'));
  assert.ok(!(await page.$eval('.table-wrap tbody', el => el.textContent))!.includes('Following-day purchase'));
  // Editing is a draft: cancelling or Escape leaves the applied filter intact.
  await page.click('.date-range-trigger');
  await clickDay('2026-09-01');
  await clickDay('2026-09-15');
  assert.match(await page.$eval('.date-range-preview', el => el.textContent!), /Sep 1, 2026.*Sep 15, 2026/);
  await page.click('.date-range-actions .btn:not(.primary)');
  assert.match(await page.$eval('.date-range-trigger', el => el.textContent!), /Sep 30, 2026 – Sep 30, 2026/);
  await page.click('.date-range-trigger');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.date-range-dialog[open]', { hidden: true });
  assert.equal(await page.$eval('.date-range-trigger', el => el === document.activeElement), true);
  assert.match((await page.$eval('.table-wrap tbody', el => el.textContent))!, /Savings purchase/);
  await page.select(account, 'bank');
  await page.waitForFunction(() => document.querySelector('.table-wrap tbody')?.textContent?.includes('End-day purchase') &&
    !document.querySelector('.table-wrap tbody')?.textContent?.includes('Savings purchase'));
  assert.doesNotMatch((await page.$eval('.table-wrap tbody', el => el.textContent))!, /Savings income/);
  await page.select(account, 'inactive');
  await page.waitForFunction(() => document.querySelector('main')?.textContent?.includes('No transactions in this period'));
  assert.ok(await page.$(account), 'account filter remains available with no matching transactions');
  await page.select(account, 'savings');
  await page.waitForFunction(() => document.querySelector('.table-wrap tbody')?.textContent?.includes('Savings purchase'));
  assert.doesNotMatch((await page.$eval('.table-wrap tbody', el => el.textContent))!, /End-day purchase|Following-day purchase/);
  await setCustomRange('2026-09-29', '2026-09-29');
  await page.waitForFunction(() => document.querySelector('main')?.textContent?.includes('No transactions in this period'));
  assert.equal(await page.$eval(account, s => (s as HTMLSelectElement).value), 'savings');
  assert.ok(await page.$(period), 'filters remain available in an empty custom period');
  await setCustomRange('2026-09-30', '2026-09-30');
  await page.select(account, '');
  await page.waitForFunction(() => document.querySelector('.table-wrap tbody')?.textContent?.includes('End-day purchase') &&
    document.querySelector('.table-wrap tbody')?.textContent?.includes('Savings purchase'));

  await page.goto(origin, { waitUntil: 'networkidle0' });
  await setCustomRange('2026-09-30', '2026-09-30');
  await page.waitForSelector('.balance-card');
  assert.match(await page.$eval('.balance-card .balance-value', el => el.textContent!), /240\.00/);
  await page.select(account, 'bank');
  await page.waitForFunction(() => document.querySelector('.balance-card .balance-value')?.textContent?.includes('80.00'));
  const net = await page.$eval('.balance-card', el => el.textContent!);
  assert.match(net, /80\.00/);
  assert.doesNotMatch(net, /5,000|10,000|4,000/);
  const charts = await page.$$eval('.chart-panel', els => els.map(el => el.textContent).join(' '));
  assert.match(charts, /Expenses/);
  assert.match(charts, /20\.00/);
  assert.match(charts, /100\.00/);
  assert.doesNotMatch(charts, /internal-transfer|card-payment|fx-exchange/);
  await page.select(account, 'savings');
  await page.waitForFunction(() => document.querySelector('.balance-card .balance-value')?.textContent?.includes('160.00'));
  const savingsCharts = await page.$$eval('.chart-panel', els => els.map(el => el.textContent).join(' '));
  assert.match(savingsCharts, /40\.00/);
  assert.match(savingsCharts, /200\.00/);
  assert.doesNotMatch(savingsCharts, /20\.00|100\.00/);
  await page.select(account, 'inactive');
  await page.waitForFunction(() => document.querySelector('main')?.textContent?.includes('No transactions in this period'));
  assert.equal(await page.$('.balance-card'), null);
  await page.select(account, '');
  await page.waitForFunction(() => document.querySelector('.balance-card .balance-value')?.textContent?.includes('240.00'));

  await setCustomRange('2026-09-30', '2026-10-01');
  await page.waitForFunction(() => document.querySelector('.balance-card .balance-value')?.textContent?.includes('660.00'));
  await page.setViewport({ width: 1440, height: 1100 });
  await page.click('.date-range-trigger');
  assert.equal(await page.$$eval('.date-range-dialog .rdp-month', months => months.length), 2);
  await page.screenshot({ path: '.context/period-calendar.png' });
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
  await page.screenshot({ path: '.context/period-calendar-dark.png' });
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
  await page.setViewport({ width: 390, height: 844 });
  await page.waitForFunction(() => document.querySelectorAll('.date-range-dialog .rdp-month').length === 1);
  assert.ok(await page.$eval('.date-range-dialog', dialog => dialog.scrollWidth <= dialog.clientWidth));
  await page.screenshot({ path: '.context/period-calendar-mobile.png' });
  await page.keyboard.press('Escape');
  await page.setViewport({ width: 1440, height: 1100 });

  assert.deepEqual(errors, []);
  console.log('Browser passed: account/date filters, dashboard totals/charts, and calendar behavior.');
} finally {
  await browser?.close();
  await vite.close();
  await new Promise<void>((resolve, reject) => api.close(error => error ? reject(error) : resolve()));
  sql.close();
}
