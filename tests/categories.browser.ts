// End-to-end category management and filters, using only an isolated in-memory API.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { serve } from '@hono/node-server';
import { createServer } from 'vite';
import puppeteer from 'puppeteer';
import { createApp } from '../server/server.ts';
import { consolidate } from '../server/ingestion/consolidation.ts';
import { date, setup, statement, txn } from './fixtures.ts';

process.env.TZ = 'America/Montevideo';
const { q, sql } = setup();
const bank = statement('bank', { transactions: [
  ...Array.from({ length: 235 }, (_, i) => txn('bank', { description: `UBER ride ${i}`, amount: -10 })),
  txn('bank', { description: 'Mystery merchant', amount: -5, currency: 'USD' }),
  txn('bank', { description: 'REMOTELY WORKS INC', amount: 1000, kind: 'income', currency: 'USD' }),
] });
const other = statement('other', { transactions: [txn('other', { description: 'KINKO', amount: -20 })] });
q.saveConsolidation(consolidate([bank, other]), [bank, other]);
q.saveTransaction({ id: 'dividend', accountId: 'bank', date: date('2026-09-10'), description: 'Dividend VOO',
  amount: 50, currency: 'USD', category: 'investment-income', source: 'manual-entry', importedAt: new Date() });
q.saveTransaction({ id: 'excluded', accountId: 'bank', date: date('2026-09-10'), description: 'UBER own movement',
  amount: -999, currency: 'UYU', category: 'internal-transfer', source: 'manual-entry', importedAt: new Date() });

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
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.setViewport({ width: 1440, height: 1100 });
  await page.emulateTimezone('America/Montevideo');
  await page.evaluateOnNewDocument(() => {
    const RealDate = Date;
    window.Date = new Proxy(RealDate, {
      construct(target, args) { return Reflect.construct(target, args.length ? args : ['2026-10-07T15:00:00Z']); },
      get(target, key) { return key === 'now' ? () => new RealDate('2026-10-07T15:00:00Z').getTime() : Reflect.get(target, key); },
    });
  });
  const url = vite.resolvedUrls!.local[0];
  const navigate = (path: string) => page.goto(`${url}${path}`, { waitUntil: 'networkidle0' });
  async function fill(selector: string, text: string) {
    await page.$eval(selector, el => { (el as HTMLInputElement).focus(); (el as HTMLInputElement).select(); });
    await page.keyboard.press('Backspace');
    await page.type(selector, text);
  }
  async function button(text: string, scope = 'main') {
    const handle = await page.evaluateHandle((text, scope) => Array.from(document.querySelectorAll(`${scope} button`)).find(el => el.textContent?.trim() === text), text, scope);
    const element = handle.asElement();
    assert.ok(element, `Button ${text}`);
    await element.click();
    await handle.dispose();
  }
  const waitCount = (count: number) => page.waitForFunction(count => document.querySelector('.details-summary .balance-note')?.textContent?.includes(`${count} transaction`), {}, count);
  const waitEditorClosed = () => page.waitForFunction(() => !document.querySelector('.rule-editor'));

  await navigate('categories');
  await fill('input[name="categoryName"]', 'Ride sharing');
  await button('Create category');
  await page.waitForFunction(() => document.querySelector('[role="status"]')?.textContent === 'Category created.');
  const rides = q.categories.list().find(c => c.name === 'Ride sharing')!;
  assert.ok(rides);
  async function createRule(name: string, categoryId: string) {
    await button('New rule');
    await fill('input[name="ruleName"]', name);
    await page.select('select[name="ruleCategory"]', categoryId);
    await fill('textarea[name="pattern"]', 'UBER|CABIFY');
    await page.waitForFunction(() => document.querySelector('.rule-preview[aria-busy="false"]')?.textContent?.includes('235 matching transactions'));
    await button('Save rule', '.rule-editor');
    await waitEditorClosed();
    await page.waitForFunction(name => document.querySelector('.rule-list li strong')?.textContent === name, {}, name).catch(async error => {
      console.error('Saved rules:', q.categories.rules().slice(0, 2));
      console.error('Rendered rule:', await page.$eval('.rule-list', el => el.textContent?.slice(0, 800)));
      await page.screenshot({ path: '.context/category-browser-failure.png' });
      throw error;
    });
  }
  await createRule('Ride matcher', rides.id);
  assert.equal(q.getTransactions().filter(t => t.categoryId === rides.id).length, 235);
  const rule = q.categories.rules()[0];
  await page.click(`[data-rule-id="${rule.id}"] button[aria-label="Edit rule Ride matcher"]`);
  await fill('textarea[name="pattern"]', '[');
  await page.waitForFunction(() => document.querySelector('.rule-preview')?.textContent?.includes('Invalid regular expression'));
  assert.equal(await page.$eval('.rule-editor button[type="submit"]', el => (el as HTMLButtonElement).disabled), true);
  await fill('textarea[name="pattern"]', 'UBER|CABIFY');
  await page.waitForFunction(() => document.querySelector('.rule-preview[aria-busy="false"]')?.textContent?.includes('235 matching transactions'));
  await page.screenshot({ path: '.context/category-rule-preview.png' });
  await button('Cancel', '.rule-editor');
  await createRule('Fallback rides', 'expense-transport');
  const fallback = q.categories.rules()[0];
  await page.click(`[data-rule-id="${fallback.id}"] button[aria-label="Move Fallback rides down"]`);
  await page.waitForFunction(() => document.querySelector('.rule-list li strong')?.textContent === 'Ride matcher');
  assert.equal(q.getTransactions().filter(t => t.categoryId === rides.id).length, 235);
  await page.click(`[data-rule-id="${rule.id}"] input[type="checkbox"]`);
  await page.waitForFunction(id => document.querySelector(`[data-rule-id="${id}"]`)?.classList.contains('rule-disabled'), {}, rule.id);
  assert.equal(q.getTransactions().filter(t => t.categoryId === rides.id).length, 0);
  await page.click(`[data-rule-id="${rule.id}"] input[type="checkbox"]`);
  await page.waitForFunction(id => !document.querySelector(`[data-rule-id="${id}"]`)?.classList.contains('rule-disabled'), {}, rule.id);
  await page.click(`[data-rule-id="${fallback.id}"] button[aria-label="Delete rule Fallback rides"]`);
  await page.waitForFunction(id => !document.querySelector(`[data-rule-id="${id}"]`), {}, fallback.id);

  await navigate('details');
  await page.select('select[name="direction"]', 'expense');
  await page.select('select[name="category"]', rides.id);
  await waitCount(235);
  assert.match(await page.$eval('.details-summary', el => el.textContent!), /-UYU\s*2,350\.00/);
  assert.ok(await page.$$eval('.details-table tbody tr', rows => rows.length < 235));
  await page.$eval('.details-scroll-status', el => el.scrollIntoView());
  await page.waitForFunction(() => document.querySelectorAll('.details-table tbody tr').length > 100);
  await page.select('select[name="direction"]', 'income');
  await waitCount(2);
  assert.equal(await page.$eval('select[name="category"]', el => (el as HTMLSelectElement).value), '');
  assert.ok(!(await page.$$eval('select[name="category"] option', options => options.map(o => o.textContent))).includes('Ride sharing'));
  await page.select('select[name="category"]', 'income-salary');
  await waitCount(1);
  assert.match(await page.$eval('.details-table', el => el.textContent!), /REMOTELY WORKS/);
  await page.select('select[name="direction"]', 'expense');
  await page.select('select[name="category"]', rides.id);
  await waitCount(235);
  assert.ok(await page.$$eval('.details-table tbody tr', rows => rows.length <= 100), 'type changes reset pagination');
  await page.select('select[name="currency"]', 'USD'); await waitCount(0);
  await page.select('select[name="currency"]', 'UYU'); await waitCount(235);
  await page.select('select[name="account"]', 'other'); await waitCount(0);
  await page.select('select[name="account"]', 'bank'); await waitCount(235);
  await page.select('select[name="period"]', '2026-08'); await waitCount(0);
  await page.select('select[name="period"]', '2026-09'); await waitCount(235);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: '.context/category-filters.png' });

  const description = await page.$eval('.details-description', el => el.textContent!);
  const changed = q.getTransactions().find(t => t.description === description)!;
  await page.click('.category-cell');
  await page.waitForSelector('dialog[open]');
  await page.select('select[name="transactionCategory"]', 'expense-groceries');
  await button('Save correction', 'dialog'); await waitCount(234);
  assert.equal(q.getTransaction(changed.id)?.categorySource, 'manual');
  await page.select('select[name="category"]', 'expense-groceries'); await waitCount(1);
  await page.click('.category-cell');
  await page.select('select[name="transactionCategory"]', '');
  await button('Save correction', 'dialog'); await waitCount(0);
  await page.select('select[name="category"]', 'uncategorized'); await waitCount(1);
  await page.click('.category-cell');
  await button('Use automatic rules', 'dialog'); await waitCount(0);
  assert.equal(q.getTransaction(changed.id)?.categorySource, 'rule');
  await page.select('select[name="currency"]', ''); await waitCount(1);
  await page.click('.category-cell');
  await button('Create matching rule', 'dialog');
  await page.select('select[name="ruleCategory"]', 'expense-shopping');
  await page.waitForFunction(() => document.querySelector('.rule-preview[aria-busy="false"]')?.textContent?.includes('1 category changes'));
  await button('Save rule', 'dialog'); await waitCount(0);
  assert.equal(q.getTransactions().find(t => t.description === 'Mystery merchant')?.categoryName, 'Shopping');

  await navigate('categories');
  await page.click(`[data-category-id="${rides.id}"] button`);
  await fill(`[data-category-id="${rides.id}"] input`, 'Local rides');
  await button('Rename', `[data-category-id="${rides.id}"]`);
  await page.waitForFunction(id => document.querySelector(`[data-category-id="${id}"] strong`)?.textContent === 'Local rides', {}, rides.id);
  await page.click(`[data-category-id="${rides.id}"] button`);
  await page.select(`[data-category-id="${rides.id}"] select`, 'expense-transport');
  await button('Merge', `[data-category-id="${rides.id}"]`);
  await page.waitForFunction(id => !document.querySelector(`[data-category-id="${id}"]`), {}, rides.id);
  assert.equal(q.getTransaction(changed.id)?.categoryName, 'Transport');
  await page.setViewport({ width: 390, height: 844 });
  await page.evaluate(() => window.scrollTo(0, 0));
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'categories fit mobile width');
  await page.screenshot({ path: '.context/categories-mobile.png' });

  await navigate('');
  await page.select('select[name="direction"]', 'income');
  await page.waitForFunction(() => document.querySelectorAll('.chart-panel:not(.tone-networth)').length === 2);
  assert.match(await page.$eval('main', el => el.textContent!), /Salary/);
  assert.match(await page.$eval('main', el => el.textContent!), /Dividends/);
  await page.select('select[name="category"]', 'income-dividends');
  assert.match(await page.$eval('.balance-card', el => el.textContent!), /50\.00/);
  await page.select('select[name="direction"]', 'expense');
  await page.select('select[name="category"]', 'expense-transport');
  await page.waitForFunction(() => document.querySelectorAll('.chart-panel:not(.tone-networth)').length === 1);
  assert.match(await page.$eval('.balance-card', el => el.textContent!), /2,350\.00/);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'dashboard filters fit mobile width');
  await page.screenshot({ path: '.context/category-dashboard-mobile.png' });
  await page.setViewport({ width: 1440, height: 1100 });
  await page.select('select[name="category"]', '');
  await page.screenshot({ path: '.context/category-dashboard.png' });
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
  await page.screenshot({ path: '.context/category-dashboard-dark.png' });
  assert.deepEqual(errors, []);
  console.log('Category browser passed: create/rename/merge, rule preview/validation/order/disable/delete, manual and automatic corrections, combined filters, totals, pagination, income/investments and responsive layouts.');
} finally {
  await browser?.close(); await vite.close(); await new Promise<void>(resolve => api.close(() => resolve())); sql.close();
}
