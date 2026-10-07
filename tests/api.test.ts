import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../server/server.ts';
import { consolidate } from '../server/ingestion/consolidation.ts';
import { setup, statement, txn } from './fixtures.ts';

process.env.TZ = 'America/Montevideo';

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
