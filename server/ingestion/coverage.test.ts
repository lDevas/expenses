import assert from 'node:assert/strict';
import { test } from 'node:test';
import { coverageGaps, mergeCoverage, statementCoverage } from './coverage.ts';
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
