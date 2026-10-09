import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../server/server.ts';
import { consolidate } from '../server/ingestion/consolidation.ts';
import { toISODate } from '../server/ingestion/types.ts';
import type { ParsedStatement } from '../server/ingestion/types.ts';
import { DatabaseQueries } from '../server/db/queries.ts';
import { setup, date, statement, txn } from './fixtures.ts';
import { buildCombinedLines, buildLines, linesNote, netWorthCardData, scopedSeries, valueAt } from '../src/lib/netWorth.ts';
import { type FxInfo } from '../src/lib/finance.ts';
import type { Account, AccountType, NetWorthReport, NetWorthSeries } from '../src/types/models.ts';

process.env.TZ = 'America/Montevideo';

// ─── consolidation balance step ───

function bankStatement(id: string, type: 'savings' | 'checking', kind: ParsedStatement['kind'], changes: Partial<ParsedStatement> = {}): ParsedStatement {
  const s = statement(id, { kind, ...changes });
  s.account.type = type;
  return s;
}

test('savings balance snapshots date to the full calendar month: opening first day, closing last day', () => {
  const s = bankStatement('savings', 'savings', 'itau-estado', { file: 'itau-2026-08.xlsx' });
  s.account.periodFrom = date('2026-08-01');
  s.account.periodTo = date('2026-08-31');
  s.account.openingBalance = 1000;
  s.account.closingBalance = 1500;
  s.transactions = [
    txn('savings', { date: date('2026-08-10'), amount: -100, balanceAfter: 900 }),
    txn('savings', { date: date('2026-08-20'), amount: 600, balanceAfter: 1500 }),
  ];

  const result = consolidate([s]);
  const rows = result.balances
    .filter(b => b.accountId === 'savings')
    .map(b => [toISODate(b.date), b.amount, b.source]);

  assert.deepEqual(rows, [
    ['2026-08-01', 1000, 'opening'],
    ['2026-08-10', 900, 'activity'],
    ['2026-08-20', 1500, 'activity'],
    ['2026-08-31', 1500, 'closing'],
  ]);
});

test('checking balance snapshots keep their exact reported dates', () => {
  const s = bankStatement('checking', 'checking', 'santander-umsatz', { file: 'sant-2026-08.csv' });
  s.account.balanceDate = date('2026-08-21');
  s.account.closingBalance = 700;
  s.transactions = [txn('checking', { date: date('2026-08-15'), amount: -30, balanceAfter: 730 })];

  const result = consolidate([s]);
  const rows = result.balances
    .filter(b => b.accountId === 'checking')
    .map(b => [toISODate(b.date), b.amount, b.source]);

  assert.deepEqual(rows, [
    ['2026-08-15', 730, 'activity'],
    ['2026-08-21', 700, 'closing'],
  ]);
});

test('same-day rows collapse to one snapshot: oldest-first ledgers keep the last row, newest-first keep the first', () => {
  const itau = bankStatement('itau', 'savings', 'itau-estado', { file: 'itau.xlsx' });
  itau.transactions = [
    txn('itau', { date: date('2026-08-15'), amount: -5, balanceAfter: 95 }),
    txn('itau', { date: date('2026-08-15'), amount: 5, balanceAfter: 90 }),
    txn('itau', { date: date('2026-08-15'), amount: 10, balanceAfter: 100 }),
  ];
  const sant = bankStatement('sant', 'checking', 'santander-umsatz', { file: 'sant.csv' });
  sant.transactions = [
    txn('sant', { date: date('2026-08-15'), amount: 10, balanceAfter: 100 }),
    txn('sant', { date: date('2026-08-15'), amount: 5, balanceAfter: 90 }),
    txn('sant', { date: date('2026-08-15'), amount: -5, balanceAfter: 95 }),
  ];

  const result = consolidate([itau, sant]);
  for (const accountId of ['itau', 'sant']) {
    const day = result.balances.filter(b => b.accountId === accountId);
    assert.equal(day.length, 1, `${accountId} should produce one same-day snapshot`);
    assert.equal(day[0].amount, 100, `${accountId}: the day's last transaction balance wins`);
    assert.equal(day[0].source, 'activity');
  }
});

test('archived sources without a typed balance fall back to the raw saldo column', () => {
  const legacy = bankStatement('legacy', 'checking', 'santander-umsatz', { file: 'legacy.csv' });
  legacy.transactions = [
    txn('legacy', { date: date('2026-08-15'), amount: -10, metadata: { raw: { saldo: '1.234,56' } } }),
  ];

  const row = consolidate([legacy]).balances.find(b => b.accountId === 'legacy');
  assert.equal(row?.amount, 1234.56);
});

test('credit and investment accounts produce no balance snapshots', () => {
  const card = bankStatement('card', 'checking', 'santander-card', { file: 'card.pdf' });
  card.account.type = 'credit';
  card.transactions = [txn('card', { amount: -45, balanceAfter: -45 })];
  const broker = bankStatement('broker', 'checking', 'ibkr-statement', { file: 'broker.csv' });
  broker.account.type = 'investment';
  broker.account.currency = 'USD';
  broker.transactions = [txn('broker', { amount: 100, currency: 'USD', balanceAfter: 100 })];

  assert.equal(consolidate([card, broker]).balances.length, 0);
});

// ─── GET /api/net-worth ───

/** August statements for one savings account: A (older) and B (a corrected re-export). */
function overlappingStatements(): ParsedStatement[] {
  const a = bankStatement('savings', 'savings', 'itau-estado', { file: 'a.xlsx' });
  a.account.periodFrom = date('2026-08-01');
  a.account.periodTo = date('2026-08-31');
  a.account.openingBalance = 1000;
  a.account.closingBalance = 1500;
  a.transactions = [
    txn('savings', { date: date('2026-08-10'), amount: -100, balanceAfter: 900 }),
    txn('savings', { date: date('2026-08-20'), amount: 500, balanceAfter: 1400 }),
  ];
  const b = bankStatement('savings', 'savings', 'santander-umsatz', { file: 'b.csv' });
  b.account.periodFrom = date('2026-08-01');
  b.account.periodTo = date('2026-08-31');
  b.account.balanceDate = date('2026-09-01'); // a later statement: wins same-day conflicts
  b.account.closingBalance = 1600;
  b.transactions = [txn('savings', { date: date('2026-08-20'), amount: 10, balanceAfter: 1450 })];
  return [a, b];
}

async function requestNetWorth(query: string): Promise<NetWorthReport> {
  const { q } = setup();
  q.saveConsolidation(consolidate(overlappingStatements()), overlappingStatements());
  const response = await createApp(q).request(`/api/net-worth${query}`);
  assert.equal(response.status, 200);
  return (await response.json()) as NetWorthReport;
}

test('endpoint: in-range snapshots keep the newer statement on same-day conflicts', async () => {
  const report = await requestNetWorth('?from=2026-08-01&to=2026-08-31');
  const series = report.banks.find(s => s.accountId === 'savings')!;
  assert.deepEqual(
    series.snapshots.map(s => [toISODate(new Date(s.date)), s.amount]),
    [
      ['2026-08-01', 1000],
      ['2026-08-10', 900],
      ['2026-08-20', 1450], // B is newer (statementTo 09-01): its running balance wins
      ['2026-08-31', 1500], // A's closing: B is savings, so its closing dates to month end (Sep 30)
    ],
  );
});

test('endpoint: a window with data gets one continuity point from before the range', async () => {
  const report = await requestNetWorth('?from=2026-09-01&to=2026-09-30');
  const series = report.banks.find(s => s.accountId === 'savings')!;
  assert.deepEqual(
    series.snapshots.map(s => [toISODate(new Date(s.date)), s.amount]),
    [
      ['2026-08-31', 1500], // continuity point: the value that carried into the window
      ['2026-09-30', 1600], // B's savings closing, dated to the month end
    ],
  );
});

test('endpoint rejects invalid ranges', async () => {
  const { q } = setup();
  const app = createApp(q);
  assert.equal((await app.request('/api/net-worth?to=2026-02-30')).status, 400);
  assert.equal((await app.request('/api/net-worth?from=2026-09-01&to=2026-08-01')).status, 400);
});

function statementWithUnreportedAccounts(): ParsedStatement[] {
  const sav = bankStatement('sav', 'savings', 'itau-estado', { file: 'sav.xlsx' });
  sav.account.periodFrom = date('2026-08-01');
  sav.account.periodTo = date('2026-08-31');
  sav.account.closingBalance = 800;
  sav.account.balanceDate = date('2026-08-31');
  sav.transactions = [txn('sav', { date: date('2026-08-10'), amount: -50, balanceAfter: 850 })];
  const chk = bankStatement('chk', 'checking', 'santander-umsatz', { file: 'chk.csv' });
  chk.transactions = [txn('chk', { date: date('2026-08-12'), amount: -20 })]; // no balance data at all
  return [sav, chk];
}

test('endpoint: accounts without balance data are listed as unreported, and the account filter scopes the report', async () => {
  const { q, sql } = setup();
  q.saveConsolidation(consolidate(statementWithUnreportedAccounts()), statementWithUnreportedAccounts());
  sql.prepare(`INSERT INTO institutions (id, name, type, country, currency) VALUES ('test-prex', 'Test Prex', 'bank', 'UY', 'UYU')`).run();
  sql.prepare(`INSERT INTO accounts (id, institution_id, name, type, currency, balance, balance_date, account_number, balance_known)
    VALUES ('prex', 'test-prex', 'Prex card', 'checking', 'UYU', 0, '2026-08-01T03:00:00.000Z', null, 0)`).run();
  const app = createApp(q);
  const range = 'from=2026-08-01&to=2026-08-31';

  const all = (await (await app.request(`/api/net-worth?${range}`)).json()) as NetWorthReport;
  assert.deepEqual(all.banks.map(s => s.accountId), ['sav']);
  assert.deepEqual(all.unreported.map(u => u.accountId).sort(), ['chk', 'prex']);

  const filtered = (await (await app.request(`/api/net-worth?${range}&account=chk`)).json()) as NetWorthReport;
  assert.deepEqual(filtered.banks, []);
  assert.deepEqual(filtered.unreported.map(u => u.accountId), ['chk']);
});

test('endpoint: investment series combine position value and broker cash per statement', async () => {
  const { q } = setup();
  const ibkr = bankStatement('ibkr', 'checking', 'ibkr-statement', { file: 'ibkr-08.csv' });
  ibkr.account.type = 'investment';
  ibkr.account.currency = 'USD';
  ibkr.account.periodFrom = date('2026-08-01');
  ibkr.account.periodTo = date('2026-08-31');
  ibkr.account.closingBalance = 500;
  ibkr.account.balanceDate = date('2026-08-31');
  ibkr.positions = [
    { accountId: 'ibkr', symbol: 'AAPL', qty: 10, costBasis: 2400, value: 2500, snapshotDate: date('2026-08-31'), currency: 'USD' },
    { accountId: 'ibkr', symbol: 'TSLA', qty: 5, costBasis: 700, value: 800, snapshotDate: date('2026-08-31'), currency: 'USD' },
  ];
  const etoro = bankStatement('etoro', 'checking', 'etoro-statement', { file: 'etoro-08.xlsx' });
  etoro.account.type = 'investment';
  etoro.account.currency = 'USD';
  etoro.account.periodFrom = date('2026-08-01');
  etoro.account.periodTo = date('2026-08-31');
  etoro.positions = [{ accountId: 'etoro', symbol: 'URA', qty: 20, costBasis: 1100, value: 1200, snapshotDate: date('2026-08-28'), currency: 'USD' }];
  etoro.transactions = [txn('etoro', { date: date('2026-08-30'), amount: 100, currency: 'USD', kind: 'deposit', metadata: { balanceAfter: 300 } })];

  q.saveConsolidation(consolidate([ibkr, etoro]), [ibkr, etoro]);
  const report = (await (await createApp(q).request('/api/net-worth?from=2026-08-01&to=2026-08-31')).json()) as NetWorthReport;

  assert.deepEqual(
    report.investments
      .map(s => [s.accountId, ...s.snapshots.map(p => [toISODate(new Date(p.date)), p.amount])])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    [
      ['etoro', ['2026-08-30', 1500]],
      ['ibkr', ['2026-08-31', 3800]],
    ],
  );
});

test('endpoint: a statement with an unpriced position yields a null observation, keeping the prior value as continuity', async () => {
  const { q } = setup();
  const mk = (file: string, month: '08' | '09', value: number | undefined) => {
    const s = bankStatement('ibkr', 'checking', 'ibkr-statement', { file });
    s.account.type = 'investment';
    s.account.currency = 'USD';
    s.account.periodFrom = date(`2026-${month}-01`);
    s.account.periodTo = date(`2026-${month}-30`);
    s.account.closingBalance = 500;
    s.account.balanceDate = date(`2026-${month}-30`);
    s.positions = [{ accountId: 'ibkr', symbol: 'AAPL', qty: 10, costBasis: 2500, value, snapshotDate: date(`2026-${month}-30`), currency: 'USD' }];
    return s;
  };
  const statements = [mk('ibkr-08.csv', '08', 2000), mk('ibkr-09.csv', '09', undefined)];
  q.saveConsolidation(consolidate(statements), statements);

  const report = (await (await createApp(q).request('/api/net-worth?from=2026-09-01&to=2026-09-30')).json()) as NetWorthReport;
  const series = report.investments.find(s => s.accountId === 'ibkr')!;
  assert.deepEqual(
    series.snapshots.map(p => [toISODate(new Date(p.date)), p.amount]),
    [
      ['2026-08-30', 2500], // continuity point from the earlier statement
      ['2026-09-30', null], // unpriced position: unknown, stays a gap
    ],
  );
});

// ─── version rebuild (legacy databases) ───

test('startup rebuild recomputes balance snapshots for databases saved before the feature', () => {
  const { q, sql } = setup();
  const legacy = bankStatement('legacy', 'checking', 'santander-umsatz', { file: 'legacy.csv' });
  legacy.account.periodFrom = date('2026-08-01');
  legacy.account.periodTo = date('2026-08-31');
  // Old parser output: no typed balanceAfter, but the raw saldo was archived.
  legacy.transactions = [txn('legacy', { date: date('2026-08-15'), amount: -10, metadata: { raw: { saldo: '1.228,51' } } })];

  q.saveConsolidation(consolidate([legacy]), [legacy]);

  // Simulate a pre-feature database: no balances in the stored result, old version.
  const state = sql.prepare('SELECT result_json FROM consolidation_state WHERE id = 1').get() as { result_json: string };
  const result = JSON.parse(state.result_json) as Record<string, unknown>;
  delete result.balances;
  sql.prepare('UPDATE consolidation_state SET result_json = ?, reconciliation_version = ?').run(JSON.stringify(result), 5);

  const q2 = new DatabaseQueries(sql); // triggers the one-time rebuild
  const version = sql.prepare('SELECT reconciliation_version FROM consolidation_state WHERE id = 1').get() as { reconciliation_version: number };
  assert.equal(version.reconciliation_version, 6);

  const series = q2.getNetWorth(date('2026-08-01'), date('2026-08-31')).banks.find(s => s.accountId === 'legacy')!;
  assert.deepEqual(
    series.snapshots.map(s => [toISODate(new Date(s.date)), s.amount]),
    [['2026-08-15', 1228.51]], // recovered from the archived raw saldo
  );
});

// ─── client library (src/lib/netWorth.ts) ───

/** Snapshots carry full ISO timestamps exactly like the API returns them. */
function clientSeries(accountId: string, accountLabel: string, accountType: AccountType, currency: string,
  snapshots: [string, number | null][]): NetWorthSeries {
  return {
    accountId, accountLabel, accountType, currency,
    snapshots: snapshots.map(([d, amount]) => ({ date: `${d}T03:00:00.000Z`, amount })),
  };
}

const acct = (id: string, type: AccountType): Account => ({
  id, institutionId: 'test', name: id, type, currency: 'USD', balance: 0, balanceDate: new Date(0),
});

const testReport: NetWorthReport = {
  from: null,
  to: null,
  banks: [
    clientSeries('s1', 'Savings UYU', 'savings', 'UYU', [['2026-08-01', 3000], ['2026-08-31', 3500]]),
    clientSeries('s2', 'Savings USD', 'savings', 'USD', [['2026-08-01', 100], ['2026-08-31', 120]]),
  ],
  investments: [clientSeries('ibkr', 'IBKR', 'investment', 'USD', [['2026-08-31', 3800]])],
  unreported: [{ accountId: 'prex', accountLabel: 'Prex · UYU', accountType: 'checking', currency: 'UYU' }],
};

const fx: FxInfo = { usdPerUyu: 1 / 40, uyuPerUsd: 40, date: '2026-08-30' };

test('valueAt carries the last observation forward and stops at null gap markers', () => {
  const s = clientSeries('a', 'A', 'savings', 'USD', [
    ['2026-08-01', 100], ['2026-08-10', 90], ['2026-08-20', null], ['2026-08-25', 95],
  ]);
  assert.equal(valueAt(s, '2026-07-15'), null); // before the first observation
  assert.equal(valueAt(s, '2026-08-05'), 100); // carried forward
  assert.equal(valueAt(s, '2026-08-15'), 90);
  assert.equal(valueAt(s, '2026-08-21'), null); // the gap marker stops the carry
  assert.equal(valueAt(s, '2026-08-31'), 95);
});

test('scopedSeries: the account filter only narrows series of the same kind as the selected account', () => {
  assert.equal(scopedSeries(testReport, 'bank', null, '').length, 2);
  assert.equal(scopedSeries(testReport, 'bank', acct('card', 'credit'), '').length, 2); // different kind: unfiltered
  assert.deepEqual(scopedSeries(testReport, 'bank', acct('s2', 'savings'), '').map(s => s.accountId), ['s2']);
  assert.deepEqual(scopedSeries(testReport, 'bank', null, 'USD').map(s => s.accountId), ['s2']); // currency filter
  assert.deepEqual(scopedSeries(testReport, 'investment', acct('s1', 'savings'), '').map(s => s.accountId), ['ibkr']);
});

test('buildLines folds convertible series into one USD line, otherwise per currency', () => {
  const [line] = buildLines('Bank', 'bank', testReport, null, '', fx);
  assert.equal(line.name, 'Bank (USD)');
  assert.deepEqual(line.points.map(p => [p.date, p.value, p.known, p.total]), [
    ['2026-08-01', 175, 2, 2], // 3000/40 + 100
    ['2026-08-31', 207.5, 2, 2], // 3500/40 + 120
  ]);

  const perCurrency = buildLines('Bank', 'bank', testReport, null, '', null);
  assert.deepEqual(perCurrency.map(l => l.name), ['Bank (USD)', 'Bank (UYU)']);
  assert.deepEqual(perCurrency[0].points.map(p => p.value), [100, 120]);
  assert.deepEqual(perCurrency[1].points.map(p => p.value), [3000, 3500]);
});

test('buildLines: any in-scope account without a known value makes the line unknown on that date', () => {
  const report: NetWorthReport = {
    from: null, to: null,
    banks: [
      clientSeries('s1', 'A', 'savings', 'USD', [['2026-08-01', 100], ['2026-08-31', 110]]),
      clientSeries('s2', 'B', 'savings', 'USD', [['2026-08-01', 20], ['2026-08-31', 50]]),
      clientSeries('s3', 'C', 'savings', 'USD', [['2026-08-01', 10], ['2026-08-31', null]]), // gap marker
    ],
    investments: [],
    unreported: [],
  };
  const [line] = buildLines('Bank', 'bank', report, null, '', fx);
  assert.deepEqual(line.points.map(p => [p.value, p.known, p.total]), [
    [130, 3, 3], // all known: 100 + 20 + 10
    [null, 2, 3], // s3 is a null gap marker: the total stays unknown, not 160
  ]);
});

test('buildCombinedLines adds a Total line only when bank and investments share one display currency', () => {
  const bank = buildLines('Bank', 'bank', testReport, null, '', fx);
  const investments = buildLines('Investments', 'investment', testReport, null, '', fx);
  const combined = buildCombinedLines(bank, investments);
  assert.deepEqual(combined.map(l => l.name), ['Bank (USD)', 'Investments', 'Total']);
  const total = combined[2];
  assert.deepEqual(total.points.map(p => [p.value, p.known, p.total]), [
    [null, 2, 3], // both bank accounts report, investments silent: total stays unknown
    [4007.5, 3, 3], // 207.5 + 3800
  ]);

  // Without an FX rate the bank lines are per currency: no clean total exists.
  const bankRaw = buildLines('Bank', 'bank', testReport, null, '', null);
  const invRaw = buildLines('Investments', 'investment', testReport, null, '', null);
  assert.deepEqual(buildCombinedLines(bankRaw, invRaw).map(l => l.name), ['Bank (USD)', 'Bank (UYU)', 'Investments (USD)']);

  // One kind missing entirely: no total line.
  assert.deepEqual(buildCombinedLines(bank, []).map(l => l.name), ['Bank (USD)']);
});

test('linesNote explains currency handling', () => {
  const converted = buildLines('Bank', 'bank', testReport, null, '', fx);
  assert.match(linesNote(converted, fx)!, /Converted to USD/);
  const raw = buildLines('Bank', 'bank', testReport, null, '', null);
  assert.match(linesNote(raw, null)!, /per currency/);
  const single = buildLines('Bank', 'bank', { ...testReport, banks: [testReport.banks[1]] }, null, '', null);
  assert.equal(linesNote(single, null), null); // one currency needs no explanation
});

test('netWorthCardData: as-of values per currency, USD total, unknowns and unreported', () => {
  const to = '2026-08-31T03:00:00.000Z';

  const all = netWorthCardData('bank', testReport, to, null, '', fx);
  assert.deepEqual(all.accounts.map(a => [a.accountId, a.amount, a.asOf]), [
    ['s1', 3500, '2026-08-31'],
    ['s2', 120, '2026-08-31'],
  ]);
  assert.equal(all.perCurrency.UYU.amount, 3500);
  assert.equal(all.perCurrency.USD.amount, 120);
  assert.equal(all.usd, 207.5);
  assert.equal(all.unknown, 0);
  assert.deepEqual(all.unreported.map(u => u.accountId), ['prex']);

  // A selected savings account narrows the card to that account only.
  const one = netWorthCardData('bank', testReport, to, acct('s2', 'savings'), '', fx);
  assert.deepEqual(one.accounts.map(a => a.accountId), ['s2']);
  assert.equal(one.usd, 120);
  assert.deepEqual(one.unreported, []);

  // A selected account of another kind leaves the card unfiltered.
  const other = netWorthCardData('bank', testReport, to, acct('ibkr', 'investment'), '', fx);
  assert.equal(other.accounts.length, 2);

  // The currency filter applies to the card too.
  const uyu = netWorthCardData('bank', testReport, to, null, 'UYU', fx);
  assert.deepEqual(uyu.accounts.map(a => a.accountId), ['s1']);
  assert.equal(uyu.usd, 87.5);

  // No FX rate: per-currency values stay, no USD total.
  const noFx = netWorthCardData('bank', testReport, to, null, '', null);
  assert.equal(noFx.usd, null);
  assert.equal(noFx.perCurrency.UYU.amount, 3500);
});

test('netWorthCardData: a mid-period "to" uses the last snapshot on or before it', () => {
  const data = netWorthCardData('bank', testReport, '2026-08-15T03:00:00.000Z', null, '', fx);
  assert.deepEqual(data.accounts.map(a => [a.amount, a.asOf]), [
    [3000, '2026-08-01'],
    [100, '2026-08-01'],
  ]);
});

test('netWorthCardData: a pre-window continuity snapshot still counts as the as-of value', () => {
  const report: NetWorthReport = {
    ...testReport,
    banks: [clientSeries('s1', 'Savings', 'savings', 'USD', [['2026-07-31', 800]])],
  };
  const data = netWorthCardData('bank', report, '2026-08-31T03:00:00.000Z', null, '', fx);
  assert.deepEqual(data.accounts.map(a => [a.amount, a.asOf]), [[800, '2026-07-31']]);
});

test('netWorthCardData: an account with no snapshot on or before the window is unknown', () => {
  const report: NetWorthReport = {
    ...testReport,
    banks: [clientSeries('s1', 'Savings', 'savings', 'USD', [['2026-09-15', 800]])],
  };
  const data = netWorthCardData('bank', report, '2026-08-31T03:00:00.000Z', null, '', fx);
  assert.equal(data.accounts[0].amount, null); // first observation is after the window
  assert.equal(data.accounts[0].asOf, null);
  assert.equal(data.unknown, 1);
  assert.equal(data.usd, null); // any unknown account keeps the total unknown
  assert.equal(data.perCurrency.USD.amount, null);
});
