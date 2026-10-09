// Focused real-browser regression; all financial data is isolated in memory.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { serve } from '@hono/node-server';
import { createServer } from 'vite';
import puppeteer from 'puppeteer';
import { createApp } from '../server/server.ts';
import { consolidate } from '../server/ingestion/consolidation.ts';
import { date, setup, statement, txn } from './fixtures.ts';

const { sql, q } = setup();
const bank = statement('bank'), savings = statement('savings');
bank.account.number = '7770001'; savings.account.number = '7770002';
savings.account.institutionId = 'another-bank';
bank.transactions = [
  txn('bank', { description: 'Real purchase', amount: -20 }),
  txn('bank', { description: 'Salary', kind: 'other', amount: 100 }),
  txn('bank', { description: 'Bank fee', kind: 'fee', amount: -2 }),
  txn('bank', { description: 'Third-party payment', kind: 'transfer-out', amount: -5, counterparty: '9999999' }),
  txn('bank', { description: 'Third-party receipt', kind: 'transfer-in', amount: 10, counterparty: '9999999' }),
  txn('bank', { description: 'Own-account debit', kind: 'transfer-out', amount: -1000, counterparty: '7770002' }),
  txn('bank', { description: 'Currency swap debit', kind: 'transfer-out', amount: -200, currency: 'USD', counterparty: '7770002' }),
  txn('bank', { description: 'Missing own-account counterpart', kind: 'transfer-out', amount: -150, counterparty: '001200769690' }),
  txn('bank', { description: 'Missing own-account sender', kind: 'transfer-in', amount: 75, counterparty: '001200769690' }),
  txn('bank', { description: 'Missing bought currency', kind: 'fx', amount: -30, currency: 'USD', date: date('2026-09-20') }),
  txn('bank', { description: 'Missing sold currency', kind: 'fx', amount: 800, date: date('2026-09-25') }),
];
bank.issues = [{ file: bank.file, severity: 'warning', message: 'Incomplete statement reference', sheet: 'Transactions', row: 12, field: 'reference' }];
savings.transactions = [
  txn('savings', { description: 'Own-account credit', kind: 'transfer-in', amount: 1000, counterparty: '7770001' }),
  txn('savings', { description: 'Currency swap credit', kind: 'transfer-in', amount: 8000, counterparty: '7770001' }),
];
const itau = statement('itau-3142914');
itau.kind = 'itau-estado';
itau.account.institutionId = 'itau-uy';
itau.account.number = '3142914';
itau.transactions = [
  ['TRASPASO A 0425741ILINK', -30],
  ['TRASPASO A 4674630ILINK', -20],
  ['TRASPASO DE 1449919ILINK', 25],
].map(([concept, amount]) => txn(itau.account.id, {
  description: String(concept), amount: Number(amount), kind: 'other',
  metadata: { raw: { concepto: concept, referencia: '', destino: 'Otro' } },
}));
const sources = [bank, savings, itau];
const legacy = consolidate(sources);
// Keep a deliberately old audit snapshot to exercise historical report repair.
legacy.items.push(...sources.flatMap(s => s.transactions.filter(t => t.counterparty !== '9999999' && t.counterparty)
  .map(t => ({ ...t, id: `legacy-${t.description}`, accountLabel: s.account.name,
    category: t.amount < 0 ? 'expense' as const : 'income' as const, sourceFiles: [s.file] }))));
q.saveConsolidation(legacy, sources);
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
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.evaluateOnNewDocument(() => {
    const RealDate = Date;
    window.Date = new Proxy(RealDate, {
      construct(target, args) { return Reflect.construct(target, args.length ? args : ['2026-10-07T15:00:00Z']); },
      get(target, key) { return key === 'now' ? () => new RealDate('2026-10-07T15:00:00Z').getTime() : Reflect.get(target, key); },
    });
  });
  await page.goto(`${origin}/details`, { waitUntil: 'networkidle0' });
  const details = await page.$eval('main', el => el.textContent!);
  assert.match(details, /Real purchase/);
  assert.match(details, /Salary/);
  assert.match(details, /Bank fee/);
  assert.match(details, /Third-party payment/);
  assert.match(details, /Third-party receipt/);
  for (const transfer of itau.transactions) assert.ok(details.includes(transfer.description));
  assert.doesNotMatch(details, /Own-account debit|Own-account credit|Currency swap debit|Currency swap credit|Missing own-account counterpart|Missing own-account sender|Missing bought currency|Missing sold currency/);
  await page.goto(origin, { waitUntil: 'networkidle0' });
  assert.match(await page.$eval('.balance-card .balance-value', el => el.textContent!), /58\.00/);
  assert.doesNotMatch(await page.$eval('.balance-card', el => el.textContent!), /1,000|8,000|150\.00|200\.00/);

  await page.goto(`${origin}/investments`, { waitUntil: 'networkidle0' });
  assert.equal(await page.$('#reconciliation-heading'), null);
  assert.equal(await page.$('#issues-heading'), null);
  await page.goto(`${origin}/ingest`, { waitUntil: 'networkidle0' });
  assert.equal(await page.$('.sidebar a[href="/breakdown"]'), null);
  const runLink = `.run-history a[aria-label="View run ${legacy.runId.slice(0, 8)}"]`;
  assert.equal(await page.$eval(runLink, a => a.getAttribute('href')), `/ingest?run=${legacy.runId}#statement-reports`);
  await page.click(runLink);
  await page.waitForSelector('#reconciliation-heading');
  const reconciliation = 'section[aria-labelledby="reconciliation-heading"]';
  const content = () => page.$eval(reconciliation, el => el.textContent!);
  assert.match(page.url(), /\/ingest\?run=/);
  assert.equal(await page.$$eval(reconciliation, sections => sections.length), 1);
  assert.equal(await page.$$eval('#issues-heading', headings => headings.length), 1);
  assert.match(await page.$eval('#statement-reports', el => el.textContent!), /Incomplete statement reference/);
  assert.match(await page.$eval('.issue-where', el => el.textContent!), /bank.csv · Transactions · row 12 · reference/);
  assert.match(await content(), /2 matched · 4 unmatched/);
  assert.doesNotMatch(await content(), /0425741|4674630|1449919/);
  assert.match(await content(), /Own-account transfer|Currency exchanges/);
  await page.select('#movement-status', 'unmatched');
  const missingCells = await page.$$eval(`${reconciliation} .reconciliation-missing-side`, cells => cells.map(cell => ({
    column: cell.closest('table')!.querySelectorAll('th')[Array.from(cell.parentElement!.children).indexOf(cell)].textContent,
    color: getComputedStyle(cell).color,
  })));
  assert.deepEqual(missingCells.map(cell => cell.column).sort(), ['Bought', 'From', 'Sold', 'To']);
  assert.ok(missingCells.every(cell => cell.color === 'rgb(198, 40, 40)'), 'missing bank and FX sides are red');
  assert.doesNotMatch(await content(), /1,000\.00|8,000\.00/);
  await page.select('#movement-status', 'matched');
  assert.match(await content(), /1,000\.00/);
  assert.match(await content(), /8,000\.00/);
  assert.equal(await page.$(`${reconciliation} .reconciliation-missing-side`), null);

  // Legacy links retain the selected upload batch, but display it on Ingestion.
  await page.goto(`${origin}/breakdown?run=${legacy.runId}`, { waitUntil: 'networkidle0' });
  assert.equal(new URL(page.url()).pathname, '/ingest');
  assert.equal(new URL(page.url()).searchParams.get('run'), legacy.runId);
  assert.match(await content(), /2 matched · 4 unmatched/);

  // Broker records historically use zero placeholders for a missing bank leg.
  const broker = statement('broker');
  broker.account.type = 'investment';
  broker.account.currency = 'USD';
  broker.transactions = [
    txn('broker', { kind: 'deposit', currency: 'USD', amount: 250, description: 'Unmatched broker deposit' }),
    txn('broker', { kind: 'withdrawal', currency: 'USD', amount: -40, description: 'Unmatched broker withdrawal' }),
    txn('broker', { kind: 'deposit', currency: 'USD', amount: 9970, description: 'Matched broker deposit after fees' }),
  ];
  broker.issues = [{ file: broker.file, severity: 'warning', message: 'Incomplete broker reference', sheet: 'Transactions', row: 12, field: 'reference' }];
  const wireBank = statement('wire-bank', { transactions: [
    txn('wire-bank', { kind: 'fx', currency: 'USD', amount: -10000, description: 'DEB. CAMBIOSST....591829',
      metadata: { raw: { concepto: 'DEB. CAMBIOSST....591829' } } }),
  ] });
  wireBank.kind = 'itau-estado';
  wireBank.account.currency = 'USD';
  const brokerSources = [broker, wireBank];
  q.saveConsolidation(consolidate(brokerSources), brokerSources);
  await page.goto(`${origin}/ingest`, { waitUntil: 'networkidle0' });
  assert.match(await page.$eval('#statement-reports', el => el.textContent!), /Incomplete broker reference/);
  assert.match(await page.$$eval('.issue-where', els => els.map(el => el.textContent!).join('\n')), /broker.csv · Transactions · row 12 · reference/);
  assert.match(await content(), /3 matched · 6 unmatched/);
  await page.select('#movement-status', 'unmatched');
  const wires = await page.$$eval(`${reconciliation} tbody tr`, rows => rows.filter(row => row.textContent!.includes('Broker wire'))
    .map(row => Array.from(row.querySelectorAll('td')).map(cell => ({ text: cell.textContent!, color: getComputedStyle(cell).color }))));
  assert.equal(wires.length, 2);
  const deposit = wires.find(row => row[3].text.includes('250.00'))!;
  const withdrawal = wires.find(row => row[2].text.includes('40.00'))!;
  assert.match(deposit[2].text, /From side missing/);
  assert.equal(deposit[2].color, 'rgb(198, 40, 40)');
  assert.match(withdrawal[3].text, /To side missing/);
  assert.equal(withdrawal[3].color, 'rgb(198, 40, 40)');
  assert.doesNotMatch(deposit[2].text + withdrawal[3].text, /0\.00/);
  assert.doesNotMatch(await content(), /10,000\.00|9,970\.00/);
  assert.equal(await page.$$eval(`${reconciliation} td:not(.reconciliation-missing-side)`, cells =>
    cells.some(cell => getComputedStyle(cell).color === 'rgb(198, 40, 40)')), false);
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
  assert.ok(await page.$$eval(`${reconciliation} .reconciliation-missing-side`, cells =>
    cells.every(cell => getComputedStyle(cell).color === 'rgb(255, 133, 133)')), 'missing sides remain red in dark mode');
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
  await page.setViewport({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'report tables stay inside the mobile viewport');
  await page.setViewport({ width: 1440, height: 1100 });
  await page.$eval('#statement-reports', el => el.scrollIntoView());
  await (await page.$('#statement-reports'))!.screenshot({ path: '.context/ingestion-reconciliation.png' });
  await page.select('#movement-status', 'matched');
  assert.match(await content(), /10,000\.00/);
  assert.match(await content(), /9,970\.00/);
  assert.match(await content(), /Difference/);
  assert.match(await content(), /\$30\.00.*Possible fees/);
  assert.doesNotMatch(await content(), /250\.00|40\.00|side missing/);
  assert.equal(await page.$(`${reconciliation} .reconciliation-missing-side`), null);
  await (await page.$(reconciliation))!.screenshot({ path: '.context/wire-fee-reconciliation.png' });

  // The all-statements link switches back from historical data without a page reload.
  await page.goto(`${origin}/ingest?run=${legacy.runId}`, { waitUntil: 'networkidle0' });
  assert.doesNotMatch(await content(), /Broker wire/);
  await page.click('#statement-reports a');
  await page.waitForFunction(() => document.querySelector('#statement-reports')?.textContent?.includes('Broker wire'));
  assert.equal(new URL(page.url()).searchParams.get('run'), null);

  await page.goto(`${origin}/ingest?run=missing-run`, { waitUntil: 'networkidle0' });
  assert.match(await page.$eval('#statement-reports [role="alert"]', el => el.textContent!), /Consolidation run not found/);

  // Uploading refreshes the current report without leaving Ingestion.
  await page.goto(`${origin}/ingest`, { waitUntil: 'networkidle0' });
  const uploadPath = resolve('.context/reconciliation-refresh.csv');
  await writeFile(uploadPath, 'Date,Description,Amount\n2026-09-10,Unknown statement layout,1\n');
  await (await page.$('input[type="file"]'))!.uploadFile(uploadPath);
  await page.waitForSelector('.upload-result');
  await page.waitForFunction(() => document.querySelector('#statement-reports .issue-list')?.textContent?.includes('reconciliation-refresh.csv'));
  assert.equal(new URL(page.url()).pathname, '/ingest');
  const uploadedRunLink = await page.$eval('.upload-result a', a => a.getAttribute('href')!);
  assert.ok(uploadedRunLink.startsWith('/ingest?run='));
  await page.click('.upload-result a');
  await page.waitForFunction(() => !!new URL(location.href).searchParams.get('run') &&
    document.querySelector('#statement-reports .issue-list')?.textContent?.includes('reconciliation-refresh.csv'));
  assert.equal(await page.$$eval(reconciliation, sections => sections.length), 1);
  assert.deepEqual(errors, []);
  console.log('Transfer browser checks passed: reports only on Ingestion for all account types, historical/upload links, automatic upload refresh, matched/unmatched filters, missing sides in light/dark mode, broker zero placeholders, and mobile layout.');
} finally {
  await browser?.close();
  await vite.close();
  await new Promise<void>((resolve, reject) => api.close(e => e ? reject(e) : resolve()));
  sql.close();
}
