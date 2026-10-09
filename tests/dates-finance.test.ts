import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getDateRangeForFilter, getDefaultFilterValue, getRecentMonths, formatDateInput, parseDateBound } from '../src/lib/dates.ts';
import { aggregateCategories, convertToUsd, fxFromExchange, isFinancialTransaction, sumByCurrency } from '../src/lib/finance.ts';
import type { Transaction } from '../src/types/models.ts';

process.env.TZ = 'America/Montevideo';

test('recent month options include the current month and six previous calendar months across years', () => {
  const months = getRecentMonths(new Date(2027, 0, 31));
  assert.deepEqual(months, [
    { value: '2027-01', label: 'January 2027' },
    { value: '2026-12', label: 'December 2026' },
    { value: '2026-11', label: 'November 2026' },
    { value: '2026-10', label: 'October 2026' },
    { value: '2026-09', label: 'September 2026' },
    { value: '2026-08', label: 'August 2026' },
    { value: '2026-07', label: 'July 2026' },
  ]);
  const february = getDateRangeForFilter('month', '2028-02');
  assert.equal(february.from, '2028-02-01T03:00:00.000Z');
  assert.equal(february.to, '2028-03-01T02:59:59.999Z');
  assert.equal(formatDateInput(new Date(2026, 8, 30, 23, 59)), '2026-09-30');
});

test('switching periods gives a compatible default and valid range for each period', () => {
  const now = new Date(2027, 0, 12);
  for (const type of ['month', 'year', 'ytd', 'custom'] as const) {
    const value = getDefaultFilterValue(type, now);
    const range = getDateRangeForFilter(type, value, '2026-09-01', '2026-09-30', now);
    assert.ok(range.from && range.to, type);
    assert.ok(new Date(range.from) <= new Date(range.to));
  }
  assert.deepEqual(getDateRangeForFilter('month', 'ytd'), {});
});

test('custom date ranges include the whole last local day, excluding the following day', () => {
  const range = getDateRangeForFilter('custom', 'custom', '2026-09-30', '2026-09-30');
  assert.equal(range.from, '2026-09-30T03:00:00.000Z');
  assert.equal(range.to, '2026-10-01T02:59:59.999Z');
  assert.ok(new Date(2026, 8, 30, 23, 59, 59, 999) <= new Date(range.to!));
  assert.ok(new Date(2026, 9, 1) > new Date(range.to!));
  assert.deepEqual(getDateRangeForFilter('custom', 'custom', '2026-10-01', '2026-09-30'), {});
  assert.deepEqual(getDateRangeForFilter('custom', 'custom', '2026-02-30', '2026-03-01'), {});
  assert.equal(parseDateBound('2028-02-29')?.getDate(), 29);
  assert.equal(parseDateBound('2027-02-29'), undefined);
  assert.equal(parseDateBound('2026-09-30T20:00:00Z', true)?.toISOString(), '2026-09-30T20:00:00.000Z');
});

test('local calendar bounds also follow daylight saving time rather than a fixed 24 hours', () => {
  process.env.TZ = 'America/New_York';
  try {
    const r = getDateRangeForFilter('custom', 'custom', '2026-03-08', '2026-03-08');
    assert.equal(new Date(r.to!).getTime() - new Date(r.from!).getTime() + 1, 23 * 60 * 60 * 1000);
  } finally { process.env.TZ = 'America/Montevideo'; }
});

test('charts and net totals exclude internal transfers, card payments and FX, but keep external transfers', () => {
  const row = (category: string, amount: number): Transaction => ({ id: category, accountId: 'bank',
    categoryName: ({ income: 'Salary', expense: 'Groceries', 'transfer-in': 'Reimbursements', 'transfer-out': 'Accountant' } as Record<string, string>)[category],
    category, amount, currency: 'UYU', date: new Date(), description: category, source: 'file-upload', importedAt: new Date() });
  const items = [row('income', 100), row('expense', -20), row('internal-transfer', 10000),
    row('card-payment', -5000), row('fx-exchange', -4000), row('transfer-in', 10), row('transfer-out', -5)];
  const financial = items.filter(isFinancialTransaction);
  assert.equal(sumByCurrency(financial).UYU, 85);
  const slices = aggregateCategories(items, null);
  assert.deepEqual(slices.map(s => s.name).sort(), ['Accountant', 'Groceries', 'Reimbursements', 'Salary']);
  const exchange = { id: 'fx', matchStatus: 'matched' as const, accountLabel: 'Bank', fromCurrency: 'UYU',
    toCurrency: 'USD', impliedRate: 0.025, sourceFiles: [] };
  assert.equal(convertToUsd(40000, 'UYU', fxFromExchange(exchange)), 1000);
});
