// Full investment workflow against an isolated API; never changes saved data.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { serve } from '@hono/node-server';
import { createServer } from 'vite';
import puppeteer from 'puppeteer';
import { createApp } from '../server/server.ts';
import { consolidate } from '../server/ingestion/consolidation.ts';
import { setup } from './fixtures.ts';
import { investmentStatements } from './investments.fixtures.ts';

process.env.TZ = 'America/Montevideo';
const { sql, q } = setup();
const statements = investmentStatements();
q.saveConsolidation(consolidate(statements), statements);
const app = createApp(q);
let mode: 'normal' | 'error' | 'empty' = 'normal';
const api = serve({ hostname: '127.0.0.1', port: 0, fetch: (request, env) => {
  if (new URL(request.url).pathname === '/api/investments' && mode !== 'normal') {
    return Response.json(mode === 'error' ? { error: 'Investment test failure' } : { accounts: [], cash: { bank: [], broker: [] }, result: null }, { status: mode === 'error' ? 500 : 200 });
  }
  return app.fetch(request, env);
} });
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
  await page.goto(`${origin}/insights`, { waitUntil: 'networkidle0' });
  assert.equal(new URL(page.url()).pathname, '/investments');
  assert.equal(await page.$eval('h1', el => el.textContent), 'Investments');
  assert.equal(await page.$('select[name="currency"]'), null);
  const period = 'select[name="period"]';
  const account = 'select[name="account"]';
  const cashCards = '.investment-cash-card';
  assert.match(await page.$eval(cashCards, el => el.textContent!), /Bank cash available to invest.*\$1,234\.50/);
  assert.match(await page.$$eval(cashCards, els => els[1].textContent!), /Cash on brokers.*\$500\.00/);
  await page.click('.investment-cash-details summary');
  assert.match(await page.$eval('.investment-cash-details', el => el.textContent!), /Sep 30, 2026/);
  assert.deepEqual(await page.$$eval(`${account} option`, els => els.map(el => (el as HTMLOptionElement).value).sort()), ['', 'etoro', 'ibkr']);
  await page.select(period, '2026-09');
  await page.waitForFunction(() => document.querySelector('[aria-labelledby="funding-heading"] tbody')?.textContent?.includes('Sep 30, 2026'));
  const positionRow = await page.$eval('.positions-table tbody', el => el.textContent!);
  assert.equal(await page.$$eval('.positions-table tbody tr', els => els.length), 1);
  assert.match(positionRow, /URA/);
  assert.match(positionRow, /35/);
  assert.match(positionRow, /\$25\.71/);
  assert.match(positionRow, /\$900\.00/);
  assert.match(positionRow, /\$1,150\.00/);
  assert.match(positionRow, /\$250\.00/);
  assert.match(positionRow, /27\.78%/);
  assert.doesNotMatch(positionRow, /OLD|BANK/);
  await page.click('.position-accounts summary');
  assert.equal(await page.$eval('.position-accounts', el => (el as HTMLDetailsElement).open), true);
  assert.match(await page.$eval('.position-accounts', el => el.textContent!), /eToro|Interactive Brokers/);
  assert.match(await page.$eval('.investment-snapshot-note', el => el.textContent!), /Jun 30, 2026.*Sep 28, 2026|Sep 28, 2026.*Jun 30, 2026/);
  const dividends = await page.$eval('[aria-labelledby="dividends-heading"] tbody', el => el.textContent!);
  assert.match(dividends, /\$40\.00/);
  assert.match(dividends, /\$10\.00/);
  assert.match(dividends, /\$30\.00/);
  assert.doesNotMatch(dividends, /interest|fee/i);
  assert.match(await page.$eval('[aria-labelledby="other-income-heading"] tbody', el => el.textContent!), /Broker interest|Broker fee/);
  assert.doesNotMatch(await page.$eval('main', el => el.textContent!), /MUST NOT LEAK|Unrelated bank transfer|NaN|OPEN/);
  assert.equal(await page.$('#statement-reports'), null, 'statement reports belong only on Ingestion');
  assert.match(await page.$eval('[aria-labelledby="funding-heading"]', el => el.textContent!), /Broker record only/);
  await page.screenshot({ path: '.context/investments-test.png', fullPage: true });

  await page.select(account, 'ibkr');
  await page.waitForFunction(() => document.querySelector('.positions-table tbody')?.textContent?.includes('$20.00'));
  assert.equal(await page.$$eval('[aria-labelledby="funding-heading"] tbody tr', els => els.length), 1);
  assert.equal(await page.$$eval('[aria-labelledby="dividends-heading"] tbody tr', els => els.length), 1);
  assert.match(await page.$$eval(cashCards, els => els[1].textContent!), /\$200\.00/);
  assert.match(await page.$eval(cashCards, el => el.textContent!), /\$1,234\.50/);
  await page.select(period, '2026-07');
  assert.match(await page.$eval('.positions-table tbody', el => el.textContent!), /OLD/);
  assert.match(await page.$eval('[aria-labelledby="dividends-heading"] tbody', el => el.textContent!), /No dividends/);
  await page.select(period, 'year');
  await page.select('select[name="year"]', '2025');
  assert.match(await page.$$eval(cashCards, els => els[1].textContent!), /\$200\.00/);
  assert.match(await page.$eval('.positions-table tbody', el => el.textContent!), /No position snapshots/);
  await page.select(period, 'custom');
  assert.match(await page.$eval('main', el => el.textContent!), /Select a complete date range/);
  await page.click('.date-range-trigger');
  await page.waitForSelector('.date-range-dialog[open]');
  await page.select('.date-range-dialog[open] .rdp-years_dropdown', '2026');
  await page.select('.date-range-dialog[open] .rdp-months_dropdown', '8');
  await page.click('.date-range-dialog[open] [data-day="2026-09-15"] button');
  await page.click('.date-range-dialog[open] [data-day="2026-09-15"] button');
  await page.click('.date-range-actions .primary');
  await page.waitForSelector('.date-range-dialog[open]', { hidden: true });
  assert.equal(await page.$$eval('[aria-labelledby="funding-heading"] tbody tr', els => els.length), 1);
  assert.match(await page.$eval('[aria-labelledby="funding-heading"] tbody', el => el.textContent!), /\$1,000\.00/);

  await page.setViewport({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'Tables scroll inside the page, not the entire mobile viewport');
  await page.screenshot({ path: '.context/investments-mobile-test.png', fullPage: true });
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
  assert.ok(await page.$('.positions-table'));

  mode = 'error';
  await page.reload({ waitUntil: 'networkidle0' });
  assert.match(await page.$eval('[role="alert"]', el => el.textContent!), /Investment test failure/);
  mode = 'normal';
  await page.click('[role="alert"] .btn');
  await page.waitForSelector('.positions-table');
  mode = 'empty';
  await page.reload({ waitUntil: 'networkidle0' });
  assert.match(await page.$eval('main', el => el.textContent!), /No investments yet/);
  assert.deepEqual(errors, []);
  console.log('Investment browser passed: broker-only data, weighted holdings, snapshot history, funding, dividends, account/month/year/custom filters, legacy redirect, mobile, retry and empty state.');
} finally {
  await browser?.close();
  await vite.close();
  await new Promise<void>((resolve, reject) => api.close(error => error ? reject(error) : resolve()));
  sql.close();
}
