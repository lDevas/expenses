import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../server/server.ts';
import { consolidate } from '../server/ingestion/consolidation.ts';
import { prexWorkbook, setup, statement, txn } from './fixtures.ts';

process.env.TZ = 'America/Montevideo';

test('deleting a transaction updates current lists and totals, without changing upload history', async () => {
  const { q, sql } = setup();
  try {
    const s = statement('bank', { transactions: [
      txn('bank', { description: 'BRL expense', amount: -1, currency: 'BRL' }),
      txn('bank', { description: 'Keep this purchase', amount: -20 }),
    ] });
    const run = consolidate([s]);
    q.saveConsolidation(run, [s]);
    const expense = q.getTransactions().find(t => t.currency === 'BRL')!;
    sql.prepare('INSERT INTO transaction_category_overrides (transaction_id, category_id) VALUES (?, NULL)').run(expense.id);
    const history = JSON.stringify(q.getConsolidated(run.runId));
    const app = createApp(q);
    const response = await app.request(`/api/transactions/${expense.id}`, { method: 'DELETE' });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { deleted: true });
    for (const route of ['/api/transactions', '/api/accounts/bank/transactions']) {
      const rows = await (await app.request(route)).json();
      assert.deepEqual(rows.map((t: { description: string }) => t.description), ['Keep this purchase']);
      assert.equal(rows.reduce((sum: number, t: { amount: number }) => sum + t.amount, 0), -20);
    }
    const current = await (await app.request('/api/statements/consolidated')).json();
    assert.equal(current.items.length, 1);
    assert.equal(current.items[0].currency, 'UYU');
    assert.equal(sql.prepare('SELECT 1 FROM transaction_category_overrides WHERE transaction_id = ?').get(expense.id), undefined);
    assert.equal(JSON.stringify(q.getConsolidated(run.runId)), history);
    assert.equal((await app.request(`/api/transactions/${expense.id}`, { method: 'DELETE' })).status, 404);
    assert.equal((await app.request('/api/transactions/missing', { method: 'DELETE' })).status, 404);
    assert.equal((sql.prepare('SELECT COUNT(*) n FROM transaction_deletions').get() as { n: number }).n, 1);
  } finally { sql.close(); }
});

test('failed deletion rolls back the transaction, deletion record, override and current view together', async () => {
  const { q, sql } = setup();
  try {
    const s = statement('bank', { transactions: [txn()] });
    q.saveConsolidation(consolidate([s]), [s]);
    const id = q.getTransactions()[0].id;
    const current = JSON.stringify(q.getConsolidated());
    sql.prepare('INSERT INTO transaction_category_overrides (transaction_id, category_id) VALUES (?, NULL)').run(id);
    sql.exec("CREATE TRIGGER reject_delete BEFORE DELETE ON transactions BEGIN SELECT RAISE(ABORT, 'test delete failure'); END");
    assert.throws(() => q.deleteTransaction(id), /test delete failure/);
    assert.ok(q.getTransaction(id));
    assert.ok(sql.prepare('SELECT 1 FROM transaction_category_overrides WHERE transaction_id = ?').get(id));
    assert.equal((sql.prepare('SELECT COUNT(*) n FROM transaction_deletions').get() as { n: number }).n, 0);
    assert.equal(JSON.stringify(q.getConsolidated()), current);
  } finally { sql.close(); }
});

test('transaction endpoints include the selected end day and reject invalid date ranges', async () => {
  const { q, sql } = setup();
  try {
    const s = statement('bank', { transactions: [
      txn('bank', { date: new Date(2026, 8, 30, 0), description: 'Start' }),
      txn('bank', { date: new Date(2026, 8, 30, 23, 59, 59, 999), description: 'End' }),
      txn('bank', { date: new Date(2026, 9, 1), description: 'Following day' }),
    ] });
    q.saveConsolidation(consolidate([s]), [s]);
    const app = createApp(q);
    for (const route of ['/api/transactions', '/api/accounts/bank/transactions']) {
      const response = await app.request(`${route}?from=2026-09-30&to=2026-09-30`);
      assert.equal(response.status, 200);
      assert.deepEqual((await response.json()).map((t: { description: string }) => t.description).sort(), ['End', 'Start']);
      assert.equal((await app.request(`${route}?to=2026-02-30`)).status, 400);
      assert.equal((await app.request(`${route}?from=2026-10-01&to=2026-09-30`)).status, 400);
    }
  } finally { sql.close(); }
});

test('upload endpoint preserves repeated rows, global state, immutable run details and repeat history', async () => {
  const { q, sql } = setup();
  try {
    const app = createApp(q);
    async function upload(csv: string) {
      const body = new FormData();
      body.append('file', new File([csv], 'CreditCardsMovementsDetail.csv'));
      const response = await app.request('/api/statements/upload', { method: 'POST', body });
      assert.equal(response.status, 201);
      return response.json();
    }
    const header = 'Número de tarjeta de crédito,Alias\nXXXX-1234,Test\nFecha,Número de tarjeta,Descripción,Pesos,Dólares\n';
    const firstCsv = header + '04/12/2025,1234,Cafe,45,0\n04/12/2025,1234,Cafe,45,0\n';
    const first = await upload(firstCsv);
    const detailBefore = await (await app.request(`/api/consolidation/runs/${first.runId}`)).json();
    assert.equal(detailBefore.items.length, 2);
    await upload(header + '05/12/2025,1234,Shop,10,0\n'); // same filename, different content
    await upload(firstCsv);
    assert.equal((await (await app.request('/api/transactions')).json()).length, 3);
    assert.equal((await (await app.request('/api/statements/consolidated')).json()).items.length, 3);
    assert.deepEqual(await (await app.request(`/api/consolidation/runs/${first.runId}`)).json(), detailBefore);
    assert.equal((await (await app.request('/api/consolidation/runs')).json()).length, 3);
    assert.equal((await (await app.request('/api/accounts/upload-ranges')).json())[0].fileCount, 2);
    assert.equal((await app.request('/api/consolidation/runs/missing')).status, 404);
  } finally { sql.close(); }
});

test('upload endpoint routes a Prex XLSX to all currency accounts and deduplicates retries', async () => {
  const { q, sql } = setup();
  try {
    const app = createApp(q);
    const buffer = prexWorkbook([
      ['Fecha', 'Descripción', 'Moneda Origen', 'Importe Origen', 'Moneda', 'Importe', 'Estado'],
      ['05/10/2026', 'Shop UY', 'UYU', -100, 'UYU', -100, 'Confirmado'],
      ['05/10/2026', 'Shop US', 'USD', -10, 'USD', -10, 'Confirmado'],
    ]);
    async function upload() {
      const body = new FormData();
      body.append('file', new File([buffer], 'estado_cuenta_20261007.xlsx'));
      const response = await app.request('/api/statements/upload', { method: 'POST', body });
      assert.equal(response.status, 201);
      return response.json();
    }
    const first = await upload();
    assert.equal(first.issueCount, 0);
    assert.equal(first.itemCount, 2);
    const detail = await (await app.request(`/api/consolidation/runs/${first.runId}`)).json();
    assert.deepEqual(detail.items.map((item: { accountId: string }) => item.accountId).sort(), ['prex-usd', 'prex-uyu']);
    const coverage = q.getAccountUploadRanges();
    assert.deepEqual(coverage.map(account => account.accountId).sort(), ['prex-usd', 'prex-uyu']);
    assert.ok(coverage.every(account => account.fileCount === 1 && account.uploads.length === 1));
    await upload();
    assert.equal(q.getTransactions().length, 2, 'retry does not duplicate financial records');
    assert.equal(q.getConsolidationRuns().length, 2, 'each attempt retains its own history');
    assert.deepEqual(await (await app.request(`/api/consolidation/runs/${first.runId}`)).json(), detail);
  } finally { sql.close(); }
});
