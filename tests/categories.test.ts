import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createApp } from '../server/server.ts';
import { CategoryStore } from '../server/categories/store.ts';
import { DatabaseQueries } from '../server/db/queries.ts';
import { applySchema } from '../server/db/schemaSql.ts';
import { consolidate } from '../server/ingestion/consolidation.ts';
import { compilePattern } from '../server/categories/engine.ts';
import { escapeRegex, matchesCategoryFilters, transactionDirection } from '../src/lib/categories.ts';
import { aggregateCategories, isFinancialTransaction } from '../src/lib/finance.ts';
import type { CategoryRuleInput } from '../src/types/categories.ts';
import type { Transaction } from '../src/types/models.ts';
import { date, setup, statement, txn } from './fixtures.ts';

function transaction(description: string, amount = -10, category = 'expense', id = description): Transaction {
  return { id, description, amount, category, accountId: 'bank', currency: 'UYU', date: date('2026-09-10'),
    source: 'file-upload', importedAt: date('2026-09-10') };
}

function draft(categoryId: string, pattern = 'Coffee'): CategoryRuleInput {
  return { categoryId, name: 'Coffee rule', pattern, enabled: true, accountingType: null };
}

test('seed rules categorize both directions and normalize bank prefixes, whitespace, case and accents', () => {
  const { q, sql } = setup();
  try {
    for (const [description, expected] of [
      ['compra UTE161643984', 'Electricity'], ['Dlo Pedidosya Suteki S', 'Food delivery'],
      ['COMPRA CON TARJETA DLO.PEDIDOSYA VIVA L', 'Food delivery'], ['FARMACITY VIA VIVA', 'Pharmacy'],
      ['I.V.A. 22% $', 'Taxes'], ['I.V.A. Cuota Anual', 'Taxes'], ['TRANSF ENVIADA IVAN PESOS', 'Outgoing transfers'],
      ['  CAFÉTERIA   SEIS MONTES ', 'Cafés'], ['Pedidosya Market', 'Groceries'],
      ['Pedidosya Propina', 'Delivery tips'], ['Pedidosya Envio', 'Delivery fees'],
      ['Pedidosya Plus', 'Delivery subscription'], ['Pedidos Ya Plus Food', 'Food delivery'],
      ['MERPAGO*ENIGMAGAMES', 'Gaming & hobbies'], ['Merpago Mercadolibre', 'Shopping'],
      ['ANTEL', 'Internet & phone'], ['CJPPU', 'Pension contributions'],
      ['NICOLAS MONTENEGRO', 'Housing'], ['ADMINISTRACIONES PUERTA DEL S', 'Housing'],
      ['UMARI', 'Restaurants'], ['ADELA', 'Restaurants'], ['PEDIDOSYA', 'Food delivery'],
      ['MONTEVIDEO BEER COMP', 'Bars & drinks'], ['MBC', 'Bars & drinks'], ['TIENDA DEL TE', 'Cafés'],
      ['LEVIS', 'Clothing'], ['LEGACY', 'Clothing'], ['STARBUCKS', 'Cafés'], ['VTOLVENTAS ONL', 'Shopping'],
      ['TANDEMUR', 'Restaurants'], ['ONE LOVE', 'Restaurants'], ['FOOD N LOVE', 'Restaurants'],
      ...['DISCO N', 'GREEN POINT', 'MORA FRUT', 'MERCADITO RIVERA', 'LOS BALDOMIR', 'BUENA VIDA ALMACEN N', 'NATAL'].map(name => [name, 'Groceries']),
      ['ANCAP', 'Fuel'], ['FARMACIA', 'Pharmacy'], ['FARMASHOP', 'Pharmacy'], ['EAC LTDA', 'Accountant'],
    ]) assert.equal(q.categories.assign([transaction(description)])[0].categoryName, expected, description);
    for (const [description, expected] of [['REMOTELY WORKS INC', 'Salary'], ['Dividend VOO', 'Dividends'], ['Interest Payment', 'Interest'], ['JUBILACIONES Y PENSIONES', 'Pensions']]) {
      assert.equal(q.categories.assign([transaction(description, 10, 'income')])[0].categoryName, expected);
    }
    assert.equal(q.categories.assign([transaction('REMOTELY WORKS INC', -28, 'fee')])[0].categoryName, 'Bank fees & interest');
    assert.equal(q.categories.assign([transaction('EAC LTDA', -70, 'fee')])[0].categoryName, 'Bank fees & interest');
    assert.equal(q.categories.assign([transaction('Unknown merchant')])[0].categorySource, 'uncategorized');
    assert.equal(q.categories.assign([transaction('UBER', 10, 'income')])[0].categoryId, null, 'expense merchant rule does not label income');
  } finally { sql.close(); }
});

test('rule order, disabling, editing and manual overrides determine live assignments and preview changes', () => {
  const { q, sql } = setup();
  try {
    const first = q.categories.saveCategory({ name: 'Coffee', direction: 'expense' });
    const second = q.categories.saveCategory({ name: 'Treats', direction: 'expense' });
    const t = transaction('Coffee shop');
    const original = q.categories.saveRule(draft(first.id));
    const higher = q.categories.saveRule(draft(second.id));
    assert.equal(q.categories.assign([t])[0].categoryId, second.id);
    const order = q.categories.rules().map(r => r.id);
    [order[0], order[1]] = [order[1], order[0]];
    q.categories.reorder(order);
    assert.equal(q.categories.assign([t])[0].categoryId, first.id);
    q.categories.saveRule({ ...original, enabled: false }, original.id);
    assert.equal(q.categories.assign([t])[0].categoryId, second.id);
    const preview = q.categories.preview({ ...higher, categoryId: first.id }, [t], higher.id);
    assert.equal(preview.matchCount, 1); assert.equal(preview.changedCount, 1);
    assert.equal(preview.examples[0].before, 'Treats'); assert.equal(preview.examples[0].after, 'Coffee');
    assert.equal(q.categories.assign([t])[0].categoryId, second.id, 'preview never saves');
    q.categories.setOverride(t, first.id);
    assert.equal(q.categories.preview({ ...higher, pattern: 'Tea' }, [t], higher.id).changedCount, 0);
    assert.equal(q.categories.assign([t])[0].categorySource, 'manual');
    q.categories.setOverride(t, null);
    assert.equal(q.categories.assign([t])[0].categorySource, 'manual');
    assert.equal(q.categories.assign([t])[0].categoryId, null);
    q.categories.resetOverride(t.id);
    const removedMatch = q.categories.preview({ ...higher, pattern: 'Tea' }, [t], higher.id);
    assert.equal(removedMatch.matchCount, 0); assert.equal(removedMatch.changedCount, 1, 'show rows that lose an old match');
    q.categories.deleteRule(higher.id);
    assert.equal(q.categories.assign([t])[0].categorySource, 'uncategorized');
    assert.throws(() => q.categories.saveRule(draft(first.id, '[')), /Invalid regular expression/);
    assert.throws(() => q.categories.reorder([]), /every rule/);
    assert.throws(() => q.categories.reorder(q.categories.rules().map(() => original.id)), /every rule/);
    assert.ok(compilePattern(escapeRegex('DLO*Cafe (UY) $20.00?')).test('DLO*Cafe (UY) $20.00?'));
  } finally { sql.close(); }
});

test('category merges redirect rules and manual overrides atomically and protect incompatible categories', () => {
  const { q, sql } = setup();
  try {
    const source = q.categories.saveCategory({ name: 'Coffee', direction: 'expense' });
    const target = q.categories.saveCategory({ name: 'Treats', direction: 'expense' });
    const income = q.categories.saveCategory({ name: 'Coffee', direction: 'income' });
    q.categories.saveRule(draft(source.id));
    const manual = transaction('Manual', -5);
    q.categories.setOverride(manual, source.id);
    assert.throws(() => q.categories.deleteCategory(source.id), /in use/);
    assert.throws(() => q.categories.merge(source.id, income.id), /same type/);
    assert.throws(() => q.categories.setOverride(manual, income.id), /match/);
    assert.throws(() => q.categories.saveCategory({ name: 'COFFEE', direction: 'expense' }), /already exists/);
    assert.throws(() => q.categories.saveCategory({ name: 'Changed', direction: 'income' }, source.id), /cannot be changed/);
    q.categories.merge(source.id, target.id);
    const rows = q.categories.assign([manual, transaction('Coffee shop')]);
    assert.ok(rows.every(row => row.categoryId === target.id));
    assert.equal(rows[0].categorySource, 'manual');
    const summary = q.categories.summary(rows).find(c => c.id === target.id)!;
    assert.equal(summary.transactionCount, 2); assert.equal(summary.overrideCount, 1); assert.equal(summary.ruleCount, 1);
    assert.throws(() => q.categories.get(source.id), /not found/);
    q.categories.deleteCategory(income.id);
    assert.throws(() => q.categories.get(income.id), /not found/);
    q.categories.saveCategory({ name: 'card-payment' }, target.id);
    assert.ok(isFinancialTransaction(q.categories.assign([manual])[0]), 'user labels never change accounting eligibility');
  } finally { sql.close(); }
});

test('overrides survive real database reopen and reconciliation; seed edits and historical snapshots stay intact', () => {
  const dir = mkdtempSync(join(tmpdir(), 'expense-categories-'));
  const path = join(dir, 'test.db');
  let sql = new Database(path);
  try {
    sql.pragma('foreign_keys = ON'); applySchema(sql);
    let q = new DatabaseQueries(sql);
    const source = statement('bank', { transactions: [txn('bank', { description: 'UBER' }), txn('bank', { description: 'UBER' })] });
    const run = consolidate([source]);
    q.saveConsolidation(run, [source]);
    const history = JSON.stringify(q.getConsolidated(run.runId));
    const before = q.getTransactions();
    const underlying = sql.prepare('SELECT * FROM transactions ORDER BY id').all();
    const category = q.categories.saveCategory({ name: 'Trips', direction: 'expense' });
    q.categories.setOverride(before[0], category.id);
    q.categories.setOverride(before[1], null);
    q.categories.deleteRule('seed-expense-transport');
    q.categories.saveCategory({ name: 'Taxis' }, 'expense-transport');
    assert.deepEqual(sql.prepare('SELECT * FROM transactions ORDER BY id').all(), underlying);
    sql.close(); sql = new Database(path); sql.pragma('foreign_keys = ON'); applySchema(sql); q = new DatabaseQueries(sql);
    assert.equal(q.categories.get('expense-transport').name, 'Taxis');
    assert.ok(!q.categories.rules().some(rule => rule.id === 'seed-expense-transport'));
    q.saveConsolidation(consolidate([source]), [source]);
    const after = q.getTransactions();
    assert.equal(after.length, 2, 'identical purchases remain distinct');
    assert.equal(after.find(row => row.id === before[0].id)?.categoryId, category.id);
    assert.equal(after.find(row => row.id === before[1].id)?.categorySource, 'manual');
    assert.equal(after.find(row => row.id === before[1].id)?.categoryId, null);
    assert.equal(JSON.stringify(q.getConsolidated(run.runId)), history);
    assert.deepEqual(after.map(t => [t.id, t.amount, t.category]), before.map(t => [t.id, t.amount, t.category]));
  } finally { if (sql.open) sql.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('type/category filters and charts use user categories without including excluded movements', () => {
  const { q, sql } = setup();
  try {
    const rows = q.categories.assign([
      transaction('UBER'), transaction('Unknown'), transaction('Dividend VOO', 20, 'investment-income'),
      ...['internal-transfer', 'card-payment', 'fx-exchange'].map(kind => transaction('UBER', -200, kind, kind)),
      transaction('UBER', 0, 'expense', 'zero'),
    ]);
    assert.equal(rows.filter(t => matchesCategoryFilters(t, '', '')).length, 7, 'All preserves existing rows');
    assert.equal(rows.filter(t => matchesCategoryFilters(t, 'expense', '')).length, 2);
    assert.equal(rows.filter(t => matchesCategoryFilters(t, 'income', '')).length, 1);
    assert.equal(rows.filter(t => matchesCategoryFilters(t, '', 'uncategorized')).length, 1);
    assert.equal(rows.filter(t => matchesCategoryFilters(t, 'expense', 'expense-transport')).length, 1);
    assert.equal(rows.filter(t => matchesCategoryFilters(t, 'income', 'expense-transport')).length, 0);
    for (const t of rows.filter(t => !transactionDirection(t))) {
      assert.equal(t.categorySource, 'excluded');
      assert.throws(() => q.categories.setOverride(t, 'expense-transport'), /cannot be categorized/);
    }
    assert.deepEqual(aggregateCategories(rows.filter(t => t.amount !== 0), null).map(s => s.name).sort(), ['Dividends', 'Transport', 'Uncategorized']);
  } finally { sql.close(); }
});

test('category APIs validate writes, provide previews, and expose additive assignments on both transaction routes', async () => {
  const { q, sql } = setup();
  try {
    const source = statement('bank', { transactions: [txn('bank', { description: 'UBER' })] });
    q.saveConsolidation(consolidate([source]), [source]);
    const id = q.getTransactions()[0].id;
    const app = createApp(q);
    const request = (path: string, method: string, data?: unknown) => app.request(`/api${path}`, {
      method, headers: { 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data),
    });
    for (const path of ['/transactions', '/accounts/bank/transactions']) {
      const row = (await (await request(path, 'GET')).json())[0];
      assert.equal(row.category, 'expense'); assert.equal(row.categoryName, 'Transport'); assert.equal(row.categorySource, 'rule');
    }
    const created = await request('/categories', 'POST', { name: 'Rides', direction: 'expense' });
    assert.equal(created.status, 201); const category = await created.json();
    const rule = draft(category.id, 'UBER');
    const preview = await (await request('/category-rules/preview', 'POST', rule)).json();
    assert.equal(preview.changedCount, 1);
    assert.equal((await request('/category-rules', 'POST', { ...rule, pattern: '[' })).status, 400);
    assert.equal((await request('/categories', 'POST', { name: '', direction: 'expense' })).status, 400);
    assert.equal((await request('/categories', 'POST', { name: 'X', direction: 'transfer' })).status, 400);
    assert.equal((await request('/categories/no-such-category', 'PUT', { name: 'Missing' })).status, 404);
    assert.equal((await request('/category-rules/order', 'PUT', { ids: [] })).status, 400);
    assert.equal((await request('/category-rules/preview', 'POST', { ...rule, id: 'missing' })).status, 404);
    const saved = await (await request('/category-rules', 'POST', rule)).json();
    assert.equal(q.getTransaction(id)?.categoryName, 'Rides');
    assert.equal((await request(`/transactions/${id}/category`, 'PUT', { categoryId: null })).status, 200);
    assert.equal(q.getTransaction(id)?.categorySource, 'manual');
    assert.equal((await request(`/transactions/${id}/category`, 'PUT', { categoryId: 'income-salary' })).status, 400);
    assert.equal((await request(`/transactions/${id}/category`, 'PUT', {})).status, 400);
    assert.equal((await request(`/transactions/${id}/category`, 'DELETE')).status, 200);
    assert.equal(q.getTransaction(id)?.categoryName, 'Rides');
    assert.equal((await request(`/categories/${category.id}`, 'DELETE')).status, 409);
    assert.equal((await request(`/category-rules/${saved.id}`, 'DELETE')).status, 200);
    assert.equal((await request(`/categories/${category.id}`, 'DELETE')).status, 200);
    assert.equal(q.getTransaction(id)?.categoryName, 'Transport');
    assert.equal((await app.request('/api/categories', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' })).status, 400);
    assert.equal((await request('/transactions/missing/category', 'PUT', { categoryId: null })).status, 404);
    // Reopening the store must not restore a rule that was deleted through the API.
    assert.ok(!new CategoryStore(sql).rules().some(r => r.id === saved.id));
  } finally { sql.close(); }
});
