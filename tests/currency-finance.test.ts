import assert from 'node:assert/strict';
import { test } from 'node:test';
import { aggregateCategories, matchesCurrencyFilter, toChartData } from '../src/lib/finance.ts';
import type { Transaction } from '../src/types/models.ts';

test('USD includes every foreign currency; UYU includes only the local currency', () => {
  const currencies = ['UYU', 'USD', 'EUR', 'ARS', 'BRL', 'GBP'];
  assert.deepEqual(currencies.filter(c => matchesCurrencyFilter(c, 'USD')), currencies.slice(1));
  assert.deepEqual(currencies.filter(c => matchesCurrencyFilter(c, 'UYU')), ['UYU']);
  assert.deepEqual(currencies.filter(c => matchesCurrencyFilter(c, '')), currencies);
});

test('currencies without a rate retain their original amounts, never a partial USD total', () => {
  const row = (currency: string, amount: number): Transaction => ({ id: currency, accountId: 'bank',
    category: 'expense', amount, currency, date: new Date(), description: currency, source: 'manual-entry', importedAt: new Date() });
  const fx = { usdPerUyu: 0.025, uyuPerUsd: 40 };
  const items = [row('USD', -10), row('EUR', -20)];
  const mixed = toChartData(aggregateCategories(items, fx), fx);
  assert.equal(mixed.currency, null);
  assert.equal(mixed.items[0].value, null);
  assert.deepEqual(mixed.items[0].perCurrency, { USD: 10, EUR: 20 });
  const euro = toChartData(aggregateCategories([items[1]], fx), fx);
  assert.equal(euro.currency, 'EUR');
  assert.equal(euro.items[0].value, 20);
  const convertible = toChartData(aggregateCategories([items[0], row('UYU', -400)], fx), fx);
  assert.equal(convertible.currency, 'USD');
  assert.equal(convertible.items[0].value, 20);
});
