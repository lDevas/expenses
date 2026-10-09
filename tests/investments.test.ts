import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../server/server.ts';
import { consolidate } from '../server/ingestion/consolidation.ts';
import { completeSum, getInvestmentView, groupPositions } from '../src/lib/investments.ts';
import type { ConsolidatedPosition, InvestmentReport } from '../src/types/models.ts';
import { getDateRangeForFilter } from '../src/lib/dates.ts';
import { setup } from './fixtures.ts';
import { date, statement, txn } from './fixtures.ts';
import { investmentStatements } from './investments.fixtures.ts';
import { brokerCashSnapshot } from '../server/ingestion/cash.ts';
import { parseIbkrCsv } from '../server/ingestion/parsers/ibkrCsv.ts';

process.env.TZ = 'America/Montevideo';

test('investment endpoint excludes bank activity and retains broker wire records without requiring a bank match', async () => {
  const { q, sql } = setup();
  try {
    const statements = investmentStatements();
    q.saveConsolidation(consolidate(statements), statements);
    const response = await createApp(q).request('/api/investments');
    assert.equal(response.status, 200);
    const report = await response.json() as InvestmentReport;
    assert.deepEqual(report.accounts.map(a => a.id).sort(), ['etoro', 'ibkr']);
    assert.ok(report.accounts.every(a => a.type === 'investment'));
    assert.equal(report.cash.bank[0].available, 1234.50);
    assert.equal(report.cash.broker.reduce((sum, b) => sum + b.available!, 0), 500);
    const result = report.result!;
    assert.ok([...result.items, ...result.positions, ...result.realized].every(r => r.accountId !== 'bank'));
    assert.ok(result.items.every(i => !i.description.includes('MUST NOT LEAK')));
    assert.equal(result.transfers.length, 4);
    assert.ok(result.transfers.every(t => t.kind === 'wire'));
    assert.ok(result.transfers.some(t => t.matchStatus === 'unmatched' && t.toAccountId === 'etoro' && t.toAmount === 500));
    assert.deepEqual(result.exchanges, []);
    assert.ok(result.files.every(file => file !== 'bank.csv'));
    assert.ok(result.issues.every(issue => issue.file !== 'bank.csv'));
    const historicalResponse = await createApp(q).request(`/api/investments?run=${result.runId}`);
    assert.equal(historicalResponse.status, 200);
    const historicalReport = await historicalResponse.json() as InvestmentReport;
    assert.ok(historicalReport.result!.items.every(i => i.accountId !== 'bank'));
    assert.equal((await createApp(q).request('/api/investments?run=missing')).status, 404);
    const view = getInvestmentView(result, report.accounts, getDateRangeForFilter('month', '2026-09'));
    assert.equal(view.positions.length, 1);
    const ura = view.positions[0];
    assert.equal(ura.symbol, 'URA');
    assert.equal(ura.qty, 35); // two eToro lots and the latest IBKR snapshot, not historical duplicates
    assert.equal(ura.costBasis, 900);
    assert.equal(ura.averageCost, 900 / 35);
    assert.equal(ura.value, 1150);
    assert.equal(ura.unrealizedPl, 250);
    assert.equal(ura.returnPct, 250 / 900 * 100);
    assert.equal(view.dividends.length, 2);
    assert.equal(view.dividends.reduce((sum, d) => sum + d.amount, 0), 50);
    assert.deepEqual(view.otherIncome.map(i => i.description).sort(), ['Broker fee', 'Broker interest']);
    assert.deepEqual(view.realized.map(r => r.symbol).sort(), ['COVER', 'URA']);
    assert.equal(view.funding.length, 3);
    assert.equal(view.funding.reduce((sum, f) => sum + f.fundingDelta, 0), 1300);
    assert.equal(view.funding[0].date, new Date(2026, 8, 30, 23, 59).toISOString());

    const ibkrView = getInvestmentView(result, report.accounts, getDateRangeForFilter('month', '2026-09'), 'ibkr');
    assert.equal(ibkrView.positions[0].qty, 10);
    assert.equal(ibkrView.positions[0].averageCost, 20);
    assert.equal(ibkrView.dividends.length, 1);
    assert.equal(ibkrView.funding.length, 1);
    const historical = getInvestmentView(result, report.accounts, getDateRangeForFilter('month', '2026-07'), 'ibkr');
    assert.deepEqual(historical.positions.map(p => p.symbol), ['OLD', 'URA']);
    assert.equal(historical.positions.find(p => p.symbol === 'URA')!.qty, 100);
    const before = getInvestmentView(result, report.accounts, getDateRangeForFilter('month', '2026-05'));
    assert.equal(before.positions.length, 0);
    const bankView = getInvestmentView(result, report.accounts, getDateRangeForFilter('month', '2026-09'), 'bank');
    assert.equal(bankView.positions.length + bankView.dividends.length + bankView.funding.length, 0);
  } finally { sql.close(); }
});

test('position aggregation preserves missing values and keeps shorts and currencies separate', () => {
  const base: ConsolidatedPosition = { id: '1', accountId: 'broker', accountLabel: 'Broker', symbol: ' ura ',
    qty: 10, costBasis: 200, value: 300, currency: 'USD', snapshotDate: '2026-09-30', sourceFiles: [] };
  const groups = groupPositions([base, { ...base, id: '2', symbol: 'URA', qty: 5, costBasis: undefined },
    { ...base, id: '3', currency: 'EUR' }, { ...base, id: '4', qty: -4, costBasis: -100, value: -120 }]);
  assert.equal(groups.length, 3);
  const usdLong = groups.find(g => g.currency === 'USD' && !g.short)!;
  assert.equal(usdLong.qty, 15);
  assert.equal(usdLong.costBasis, undefined);
  assert.equal(usdLong.averageCost, undefined);
  assert.equal(usdLong.unrealizedPl, undefined);
  assert.equal(usdLong.value, 600);
  assert.equal(groups.find(g => g.short)!.averageCost, 25);
  assert.equal(completeSum([]), undefined);
  assert.equal(completeSum([1, NaN]), undefined);
});

test('investments without uploaded statements returns an empty report, not an error', async () => {
  const { q, sql } = setup();
  try {
    const response = await createApp(q).request('/api/investments');
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { accounts: [], cash: { bank: [], broker: [] }, result: null });
  } finally { sql.close(); }
});

test('cash separates currencies, ignores card/loan balances and never treats unknown or borrowed cash as available', () => {
  const { q, sql } = setup();
  try {
    const statements = investmentStatements();
    const uyu = statement('pesos');
    uyu.account.closingBalance = 40000;
    const overdraft = statement('overdraft');
    overdraft.account.closingBalance = -200;
    const card = statement('credit');
    card.account.type = 'credit';
    card.account.closingBalance = 99999;
    const unknown = statement('unknown-bank');
    const broker = statement('unknown-broker');
    broker.account.type = 'investment';
    const zero = statement('zero');
    zero.account.closingBalance = 0;
    statements.push(uyu, overdraft, card, unknown, broker, zero);
    q.saveConsolidation(consolidate(statements), statements);
    q.saveAccount({ id: 'loan', institutionId: 'test-bank', name: 'Loan', type: 'loan',
      currency: 'USD', balance: 99999, balanceDate: date('2026-09-30') });
    const cash = q.getInvestmentCash();
    assert.ok(cash.bank.every(b => !['credit', 'loan'].includes(b.accountId)));
    assert.equal(cash.bank.find(b => b.accountId === 'overdraft')!.available, 0);
    assert.equal(cash.bank.find(b => b.accountId === 'overdraft')!.balance, -200);
    assert.equal(cash.bank.find(b => b.accountId === 'unknown-bank')!.available, null);
    assert.equal(cash.bank.find(b => b.accountId === 'unknown-bank')!.balanceDate, null);
    assert.equal(cash.bank.find(b => b.accountId === 'zero')!.available, 0);
    assert.equal(cash.broker.find(b => b.accountId === 'unknown-broker')!.available, null);
    assert.equal(cash.bank.filter(b => b.currency === 'USD').reduce((sum, b) => sum + (b.available ?? 0), 0), 1234.50);
    assert.equal(cash.bank.filter(b => b.currency === 'UYU').reduce((sum, b) => sum + (b.available ?? 0), 0), 40000);
  } finally { sql.close(); }
});

test('IBKR secondary NAV headers do not discard cash or confuse stock value with cash', () => {
  const csv = [
    'Statement,Header,Field Name,Field Value',
    'Statement,Data,Period,"January 1, 2026 - September 30, 2026"',
    'Account Information,Header,Field Name,Field Value',
    'Account Information,Data,Account,U123',
    'Net Asset Value,Header,Asset Class,Prior Total,Current Long,Current Short,Current Total,Change',
    'Net Asset Value,Data,Cash ,0,212.95,0,212.95,212.95',
    'Net Asset Value,Data,Stock,0,80000,0,80000,80000',
    'Net Asset Value,Header,Time Weighted Rate of Return',
    'Net Asset Value,Data,118.7%',
  ].join('\n');
  const parsed = parseIbkrCsv(Buffer.from(csv), 'U123.csv');
  assert.equal(parsed.summary['NAV Cash total'], 212.95);
  assert.equal(brokerCashSnapshot(parsed)!.amount, 212.95);
  assert.equal(brokerCashSnapshot(parsed)!.date.toISOString(), date('2026-09-30').toISOString());
});

test('broker cash uses the latest reported balance, including same-timestamp activity, not equity or deposits', () => {
  const broker = investmentStatements()[1];
  broker.summary['Ending Realized Equity'] = 50000;
  broker.transactions = [
    txn('etoro', { currency: 'USD', date: date('2026-09-30'), amount: 9999, metadata: { balanceAfter: 20 } }),
    txn('etoro', { currency: 'USD', date: date('2026-09-30'), metadata: { balanceAfter: 25 } }),
    txn('etoro', { currency: 'USD', date: date('2026-09-01'), metadata: { balanceAfter: 1000 } }),
    txn('etoro', { currency: 'EUR', date: date('2026-10-01'), metadata: { balanceAfter: 999 } }),
  ];
  assert.equal(brokerCashSnapshot(broker)!.amount, 25);
  const { q, sql } = setup();
  try {
    const older = structuredClone(broker);
    older.file = 'older.csv';
    older.transactions = [txn('etoro', { currency: 'USD', date: date('2026-08-01'), metadata: { balanceAfter: 10000 } })];
    q.saveConsolidation(consolidate([broker, older]), [broker, older]);
    assert.equal(q.getInvestmentCash().broker[0].balance, 25);
    assert.equal(q.getInvestmentCash().broker[0].source, 'activity');
  } finally { sql.close(); }
});
