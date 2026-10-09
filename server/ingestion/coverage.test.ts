import assert from 'node:assert/strict';
import { test } from 'node:test';
import { coverageGaps, mergeCoverage, normalizeUploadRange, statementCoverage } from './coverage.ts';
import { parseStatementDate } from './types.ts';
import type { ParsedStatement } from './types.ts';

const date = (value: string) => parseStatementDate(value)!;
const statement = (): ParsedStatement => ({
  kind: 'ibkr-statement', file: 'test.csv',
  account: { id: 'a', institutionId: 'ibkr', institutionName: 'IBKR', name: 'A', type: 'investment', currency: 'USD' },
  transactions: [], positions: [], realized: [], summary: {}, issues: [],
});

test('merges unordered, adjacent, overlapping and nested ranges without hiding gaps', () => {
  const input = [
    { from: '2026-03-01', to: '2026-03-31' },
    { from: '2026-01-15', to: '2026-01-20' },
    { from: '2026-02-01', to: '2026-02-10' },
    { from: '2026-01-01', to: '2026-01-31' },
    { from: '2026-03-20', to: '2026-04-05' },
  ];
  const original = structuredClone(input);
  const merged = mergeCoverage(input);
  assert.deepEqual(merged, [{ from: '2026-01-01', to: '2026-02-10' }, { from: '2026-03-01', to: '2026-04-05' }]);
  assert.deepEqual(input, original);
  assert.deepEqual(coverageGaps(merged, '2026-05-06'), [
    { from: '2026-02-11', to: '2026-02-28', days: 18, kind: 'internal' },
    { from: '2026-04-06', to: '2026-05-06', days: 31, kind: 'trailing' },
  ]);
});

test('handles one-day gaps, leap days, future coverage and exactly 30-day grace period', () => {
  const ranges = mergeCoverage([{ from: '2024-02-01', to: '2024-02-28' }, { from: '2024-03-01', to: '2024-03-31' }]);
  assert.deepEqual(coverageGaps(ranges, '2024-04-30'), [{ from: '2024-02-29', to: '2024-02-29', days: 1, kind: 'internal' }]);
  assert.deepEqual(coverageGaps([{ from: '2026-01-01', to: '2026-12-31' }], '2026-10-06'), []);
  assert.deepEqual(coverageGaps([], '2026-10-06'), []);
});

test('uses explicit statement periods even for empty statements; activity and unknown are labeled', () => {
  const s = statement();
  s.account.periodFrom = date('2026-01-01');
  s.account.periodTo = date('2026-01-31');
  s.account.periodSource = 'statement';
  assert.deepEqual(statementCoverage(s), { from: '2026-01-01', to: '2026-01-31', basis: 'statement' });
  delete s.account.periodSource;
  assert.equal(statementCoverage(s).basis, 'activity');
  s.account.periodFrom = new Date(NaN);
  delete s.account.periodTo;
  assert.deepEqual(statementCoverage(s), { from: null, to: null, basis: 'unknown' });
  s.realized.push({ accountId: 'a', symbol: 'X', date: date('2026-03-02'), realizedPl: 10, currency: 'USD' });
  assert.deepEqual(statementCoverage(s), { from: '2026-03-02', to: '2026-03-02', basis: 'activity' });
});

test('savings activity covers all of August, even with a single transaction, without changing source dates', () => {
  const s = statement();
  s.account.type = 'savings';
  s.transactions = [{ accountId: 'a', date: date('2026-08-27'), description: 'Purchase', amount: -5, currency: 'USD', kind: 'purchase' }];
  const original = structuredClone(s);
  assert.deepEqual(statementCoverage(s), { from: '2026-08-01', to: '2026-08-31', basis: 'activity' });
  s.transactions.push({ ...s.transactions[0], date: date('2026-08-05') });
  assert.deepEqual(statementCoverage(s), { from: '2026-08-01', to: '2026-08-31', basis: 'activity' });
  s.transactions.pop();
  assert.deepEqual(s, original);
});

test('savings statement periods expand over leap days, December and multiple months', () => {
  for (const [from, to, expectedFrom, expectedTo] of [
    ['2024-02-05', '2024-02-20', '2024-02-01', '2024-02-29'],
    ['2025-02-05', '2025-02-20', '2025-02-01', '2025-02-28'],
    ['2026-12-10', '2026-12-27', '2026-12-01', '2026-12-31'],
    ['2026-12-15', '2027-01-14', '2026-12-01', '2027-01-31'],
    ['2026-08-15', '2026-10-14', '2026-08-01', '2026-10-31'],
  ]) {
    const s = statement();
    s.account = { ...s.account, type: 'savings', periodFrom: date(from), periodTo: date(to), periodSource: 'statement' };
    const original = structuredClone(s);
    assert.deepEqual(statementCoverage(s), { from: expectedFrom, to: expectedTo, basis: 'statement' });
    assert.deepEqual(s, original);
  }
});

test('only savings coverage expands; other account types retain exact statement and activity dates', () => {
  for (const type of ['checking', 'credit', 'investment'] as const) {
    const s = statement();
    s.account = { ...s.account, type, periodFrom: date('2026-08-15'), periodTo: date('2026-09-14'), periodSource: 'statement' };
    assert.deepEqual(statementCoverage(s), { from: '2026-08-15', to: '2026-09-14', basis: 'statement' });
    delete s.account.periodFrom;
    delete s.account.periodTo;
    s.transactions = [{ accountId: 'a', date: date('2026-08-27'), description: 'Purchase', amount: -5, currency: 'USD', kind: 'purchase' }];
    assert.deepEqual(statementCoverage(s), { from: '2026-08-27', to: '2026-08-27', basis: 'activity' });
  }
});

test('savings with no valid dates stay unknown and normalization is idempotent', () => {
  const s = statement();
  s.account.type = 'savings';
  s.account.periodFrom = new Date(NaN);
  assert.deepEqual(statementCoverage(s), { from: null, to: null, basis: 'unknown' });
  const original = { from: '2026-08-05', to: '2026-08-27' };
  const normalized = normalizeUploadRange(original, 'savings');
  assert.deepEqual(normalizeUploadRange(normalized, 'savings'), normalized);
  assert.deepEqual(original, { from: '2026-08-05', to: '2026-08-27' });
});
