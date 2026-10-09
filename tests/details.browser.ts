// Real-browser Details regression using only an in-memory API/database.
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
const longDescription = 'A long uploaded bank description with merchant, reference and payment details that should wrap into multiple lines instead of being truncated.';
const bank = statement('bank', { transactions: Array.from({ length: 451 }, (_, i) => txn('bank', {
  date: new Date(2026, 10, 30, 12, 0, 0, 451 - i),
  description: `Scroll purchase ${i} · ${longDescription}`,
  amount: i % 2 === 0 ? -1.25 : -2.5, currency: i % 2 === 0 ? 'UYU' : 'USD',
})) });
const savings = statement('savings', { transactions: [txn('savings', {
  date: new Date(2026, 10, 1, 12), description: 'Last transaction in the period',
  amount: 300, kind: 'other',
})] });
// Both exchanges are on other accounts and outside the selected November
// period. The newer reverse-direction exchange retains unrounded precision.
const inactive = statement('inactive', { transactions: [txn('inactive'),
  txn('inactive', { kind: 'fx', reference: 'older-fx', amount: -40000 }),
  txn('inactive', { kind: 'fx', reference: 'latest-fx', amount: 40123.456,
    date: new Date(2026, 11, 15, 12) }),
] });
const fxAccount = statement('fx-usd', { transactions: [
  txn('fx-usd', { kind: 'fx', reference: 'older-fx', currency: 'USD', amount: 1000 }),
  txn('fx-usd', { kind: 'fx', reference: 'latest-fx', currency: 'USD', amount: -1000,
    date: new Date(2026, 11, 15, 12) }),
] });
fxAccount.account.currency = 'USD';
const statements = [bank, savings, inactive, fxAccount];
q.saveConsolidation(consolidate(statements), statements);
assert.equal(q.getLatestExchange()!.impliedRate, 40.123456);

const api = serve({ fetch: createApp(q).fetch, hostname: '127.0.0.1', port: 0 });
if (!api.listening) await once(api, 'listening');
const address = api.address();
assert.ok(address && typeof address !== 'string');
const vite = await createServer({ server: { host: '127.0.0.1', port: 0,
  proxy: { '/api': { target: `http://127.0.0.1:${address.port}` } } }, logLevel: 'silent' });
let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
try {
  await vite.listen();
  browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1100 });
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
  await page.goto(`${vite.resolvedUrls!.local[0]}details`, { waitUntil: 'networkidle0' });
  const period = '.filter-bar select[name="period"]';
  const account = '.filter-bar select[name="account"]';
  const summary = '.details-summary';
  await page.select(period, '2026-11');
  await page.waitForSelector('.details-table tbody tr');
  await page.waitForSelector('.details-summary[aria-busy="false"]');
  assert.deepEqual(await page.$$eval('.details-table th', headers => headers.map(h => h.textContent)),
    ['Date', 'Description', 'Category', 'Amount', 'Actions']);
  const initialTotals = await page.$eval(summary, el => el.textContent!);
  assert.match(initialTotals, /17\.50/);
  assert.match(initialTotals, /-\$562\.50/);
  assert.match(initialTotals, /452 transactions/);
  const initialNet = await page.$$eval('.details-net .balance-value', values => values.map(v => v.textContent));
  assert.deepEqual(initialNet, ['-$562.06', '-UYU 22,551.94']);
  assert.match(await page.$eval('.details-net-note', el => el.textContent!), /40\.12 UYU per USD/);
  const summaryLayout = await page.$$eval('.details-totals, .details-net', els => els.map(el => el.getBoundingClientRect().toJSON()));
  assert.ok(summaryLayout[1].x >= summaryLayout[0].right, 'net is to the right of the currency totals');
  const initialRows = await page.$$eval('.details-table tbody tr', rows => rows.length);
  assert.ok(initialRows < 200, 'first batch does not render the entire result');
  assert.equal(await page.$eval('.details-description', el => getComputedStyle(el).whiteSpace), 'normal');
  const columnWidths = await page.$$eval('.details-table th', cells => cells.map(c => c.getBoundingClientRect().width));
  assert.ok(columnWidths[1] > columnWidths[0] && columnWidths[1] > columnWidths[2] && columnWidths[1] > columnWidths[3],
    'description receives the largest column');
  await page.screenshot({ path: '.context/details-summary.png' });
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
  await page.screenshot({ path: '.context/details-summary-dark.png' });
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
  await page.setViewport({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'mobile layout fits the viewport');
  await (await page.$(summary))!.screenshot({ path: '.context/details-summary-mobile.png' });
  await page.setViewport({ width: 1440, height: 1100 });

  let rendered = initialRows;
  while (rendered < 452) {
    await page.$eval('.details-scroll-status', el => el.scrollIntoView());
    await page.waitForFunction(previous => document.querySelectorAll('.details-table tbody tr').length > previous, {}, rendered);
    rendered = await page.$$eval('.details-table tbody tr', rows => rows.length);
  }
  assert.match(await page.$eval('.details-table tbody', el => el.textContent!), /Scroll purchase 450/);
  assert.match(await page.$eval('.details-table tbody', el => el.textContent!), /Last transaction in the period/);
  assert.match(await page.$eval('.details-scroll-status', el => el.textContent!), /Showing 452 of 452.*All transactions shown/);
  assert.equal(await page.$('.details-scroll-status button'), null);
  assert.equal(await page.$$eval('.details-description', cells => new Set(cells.map(c => c.textContent)).size), 452);
  assert.equal(await page.$eval(summary, el => el.textContent!), initialTotals, 'scrolling does not change totals');

  await page.evaluate(() => window.scrollTo(0, 0));
  await page.select(account, 'bank');
  await page.waitForFunction(() => document.querySelector('.details-summary')?.textContent?.includes('451 transactions'));
  assert.match(await page.$eval(summary, el => el.textContent!), /-UYU\s*282\.50/);
  assert.match(await page.$eval(summary, el => el.textContent!), /-\$562\.50/);
  assert.deepEqual(await page.$$eval('.details-net .balance-value', values => values.map(v => v.textContent)),
    ['-$569.54', '-UYU 22,851.94']);
  assert.ok(await page.$$eval('.details-table tbody tr', rows => rows.length < 200), 'account changes reset the batch');
  await page.focus('.details-scroll-status button');
  const beforeLoadButton = await page.$$eval('.details-table tbody tr', rows => rows.length);
  await page.keyboard.press('Enter');
  await page.waitForFunction(previous => document.querySelectorAll('.details-table tbody tr').length > previous, {}, beforeLoadButton);

  await page.evaluate(() => window.scrollTo(0, 0));
  await page.select(account, 'savings');
  await page.waitForFunction(() => document.querySelector('.details-summary')?.textContent?.includes('1 transaction'));
  assert.match(await page.$eval(summary, el => el.textContent!), /UYU\s*300\.00/);
  assert.match(await page.$eval(summary, el => el.textContent!), /Total \(USD\)\$0\.00/);
  assert.deepEqual(await page.$$eval('.details-net .balance-value', values => values.map(v => v.textContent)),
    ['$7.48', 'UYU 300.00']);
  assert.equal(await page.$$eval('.details-table tbody tr', rows => rows.length), 1);
  await page.select(period, '2026-12');
  await page.waitForFunction(() => document.querySelector('main')?.textContent?.includes('No transactions in this period'));
  assert.match(await page.$eval(summary, el => el.textContent!), /Total \(UYU\)UYU\s*0\.00/);
  assert.match(await page.$eval(summary, el => el.textContent!), /Total \(USD\)\$0\.00/);
  assert.deepEqual(await page.$$eval('.details-net .balance-value', values => values.map(v => v.textContent)),
    ['$0.00', 'UYU 0.00']);

  // The same filtered data produces precisely the same normalized values
  // as the Dashboard, using the global latest rate rather than a period rate.
  await page.goto(vite.resolvedUrls!.local[0], { waitUntil: 'networkidle0' });
  await page.select(period, '2026-11');
  await page.waitForSelector('.balance-card .balance-value');
  assert.deepEqual(await page.$$eval('.balance-card .balance-value', values => values.map(v => v.textContent!.replace('−', '-'))), initialNet);

  // Missing FX must not silently produce a partial mixed-currency net.
  await page.setRequestInterception(true);
  let rejectDeletion = true;
  page.on('request', request => {
    if (request.method() === 'DELETE' && rejectDeletion) {
      void request.respond({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Could not delete transaction' }) });
    } else if (new URL(request.url()).pathname === '/api/fx/latest') {
      void request.respond({ status: 200, contentType: 'application/json', body: 'null' });
    } else void request.continue();
  });
  await page.goto(`${vite.resolvedUrls!.local[0]}details`, { waitUntil: 'networkidle0' });
  await page.select(period, '2026-11');
  await page.waitForSelector('.details-summary[aria-busy="false"]');
  assert.deepEqual(await page.$$eval('.details-net .balance-value', values => values.map(v => v.textContent)), ['—', '—']);
  assert.match(await page.$eval('.details-totals', el => el.textContent!), /17\.50.*562\.50/);
  assert.doesNotMatch(await page.$eval(summary, el => el.textContent!), /NaN/);
  await page.select(account, 'savings');
  await page.waitForFunction(() => document.querySelector('.details-summary')?.textContent?.includes('1 transaction'));
  assert.deepEqual(await page.$$eval('.details-net .balance-value', values => values.map(v => v.textContent)), ['—', 'UYU 300.00']);

  // Cancellation and failures must leave financial data intact. Success must
  // update all totals immediately and persist across page reloads/uploads.
  const deleteButton = '.details-delete';
  await page.click(deleteButton);
  await page.waitForSelector('.transaction-delete-dialog[open]');
  assert.match(await page.$eval('.transaction-delete-dialog', el => el.textContent!), /Last transaction in the period/);
  assert.equal(await page.$eval('.transaction-delete-dialog button', el => el === document.activeElement), true, 'cancel receives initial focus');
  await page.click('.transaction-delete-actions button:first-child');
  await page.waitForFunction(() => !document.querySelector('.transaction-delete-dialog'));
  assert.equal(q.getTransactions('savings').length, 1, 'cancel leaves the transaction intact');
  await page.click(deleteButton);
  await page.click('.transaction-delete-actions .danger');
  await page.waitForSelector('.transaction-delete-dialog [role="alert"]');
  assert.match(await page.$eval('.transaction-delete-dialog [role="alert"]', el => el.textContent!), /Could not delete/);
  assert.equal(q.getTransactions('savings').length, 1, 'failed deletion does not remove a row');
  assert.match(await page.$eval(summary, el => el.textContent!), /UYU\s*300\.00/);
  rejectDeletion = false;
  await page.click('.transaction-delete-actions .danger');
  await page.waitForFunction(() => !document.querySelector('.transaction-delete-dialog'));
  assert.equal(q.getTransactions('savings').length, 0);
  assert.equal(await page.$$eval('.details-table tbody tr', rows => rows.length), 0);
  assert.match(await page.$eval(summary, el => el.textContent!), /0 transactions/);
  assert.deepEqual(await page.$$eval('.details-net .balance-value', values => values.map(v => v.textContent)), ['$0.00', 'UYU 0.00']);
  assert.match(await page.$eval('.details-page', el => el.textContent!), /Totals updated/);
  await page.reload({ waitUntil: 'networkidle0' });
  await page.select(period, '2026-11');
  await page.select(account, 'savings');
  await page.waitForSelector('.details-summary[aria-busy="false"]');
  assert.match(await page.$eval(summary, el => el.textContent!), /0 transactions/);
  q.saveConsolidation(consolidate(statements), statements);
  assert.equal(q.getTransactions('savings').length, 0, 'repeat upload does not restore the deleted transaction');
  assert.deepEqual(errors, []);
  console.log('Browser passed: Details deletion/cancellation/failure/reload, infinite scroll, currency totals, Dashboard FX/net parity, latest-rate precision, filter resets, missing FX, and mobile/dark layouts.');
} finally {
  await browser?.close();
  await vite.close();
  await new Promise<void>((resolve, reject) => api.close(error => error ? reject(error) : resolve()));
  sql.close();
}
