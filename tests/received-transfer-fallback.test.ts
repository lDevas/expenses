import assert from 'node:assert/strict';
import { test } from 'node:test';
import { consolidate } from '../server/ingestion/consolidation.ts';
import { DatabaseQueries } from '../server/db/queries.ts';
import { createApp } from '../server/server.ts';
import { date, setup, statement, txn } from './fixtures.ts';
import type { ParsedStatement, RawTxn } from '../server/ingestion/types.ts';

/**
 * Two bank accounts: `b` receives a transfer, `a` sends one. Both statements
 * carry the same day (2026-09-10) unless overridden.
 */
function pair(receipt: Partial<RawTxn> = {}, sender: Partial<RawTxn> = {}): ParsedStatement[] {
  const a = statement('a'), b = statement('b');
  b.account.institutionId = 'another-bank';
  a.transactions = [txn('a', { description: 'Out', kind: 'transfer-out', amount: -500, ...sender })];
  b.transactions = [txn('b', { description: 'In', kind: 'transfer-in', amount: 500, ...receipt })];
  return [a, b];
}

test('a received transfer matches a same-value debit on another account on the same day, in either input order', () => {
  for (const [a, b] of [pair(), [pair()[1], pair()[0]]]) {
    const r = consolidate([a, b]);
    assert.equal(r.items.length, 0);
    assert.equal(r.exchanges.length, 0);
    assert.equal(r.transfers.length, 1);
    assert.equal(r.transfers[0].kind, 'internal');
    assert.equal(r.transfers[0].matchStatus, 'matched');
    assert.equal(r.transfers[0].fromAccountId, 'a');
    assert.equal(r.transfers[0].toAccountId, 'b');
    assert.equal(r.transfers[0].fromAmount, 500);
    assert.equal(r.transfers[0].toAmount, 500);
    assert.deepEqual(r.transfers[0].sourceFiles.sort(), ['a.csv', 'b.csv']);
  }
});

test('the value window is eight days, no wider', () => {
  for (const day of ['2026-09-02', '2026-09-09', '2026-09-11', '2026-09-18']) {
    const [a, b] = pair({ date: date(day) });
    const r = consolidate([a, b]);
    assert.equal(r.items.length, 0, `${day} reconciles`);
    assert.equal(r.transfers[0].matchStatus, 'matched');
  }
  for (const day of ['2026-09-01', '2026-09-19']) {
    const [a, b] = pair({ date: date(day) });
    const r = consolidate([a, b]);
    assert.equal(r.transfers.length, 0, `${day} stays unresolved`);
    assert.equal(r.items.length, 2);
  }
});

test('values in different currencies never match, and same-account rows never pair', () => {
  const differentCurrency = consolidate(pair({ currency: 'USD' }));
  assert.equal(differentCurrency.transfers.length, 0);
  assert.equal(differentCurrency.items.length, 2);
  const [a, b] = pair();
  a.account = { ...a.account, id: 'same', number: '7770001' };
  b.account = { ...b.account, id: 'same' };
  b.transactions = [txn('same', { description: 'In', kind: 'transfer-in', amount: 500 })];
  const sameAccount = consolidate([a, b]);
  assert.equal(sameAccount.transfers.length, 0);
  assert.equal(sameAccount.items.length, 2);
});

test('an explicit account number on either leg pins its counterparty and vetoes the value match', () => {
  const receiptNumber = consolidate(pair({ counterparty: '9999999' }));
  assert.equal(receiptNumber.transfers.length, 0);
  assert.equal(receiptNumber.items.length, 2);
  const senderNumber = consolidate(pair({}, { counterparty: '8888888' }));
  assert.equal(senderNumber.transfers.length, 0);
  assert.equal(senderNumber.items.length, 2);
});

test('a counterparty number identifying another known account vetoes the value match; the receipt shows the missing side', () => {
  const [a, b] = pair({ counterparty: '1234567' });
  const c = statement('c');
  c.account.number = '1234567';
  c.transactions = [];
  const r = consolidate([a, b, c]);
  assert.equal(r.transfers.length, 1);
  assert.equal(r.transfers[0].matchStatus, 'unmatched');
  // The receipt's counterparty identifies c, so its missing FROM side is c.
  assert.equal(r.transfers[0].fromAccountId, 'c');
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].accountId, 'a');
});

test('plain third-party names never veto: a named receipt still matches its same-value sender', () => {
  const r = consolidate(pair({ counterparty: 'JOSE RODRIGUEZ' }, { counterparty: undefined }));
  assert.equal(r.items.length, 0);
  assert.equal(r.transfers.length, 1);
  assert.equal(r.transfers[0].matchStatus, 'matched');
});

test('ambiguous values never guess in either direction', () => {
  // Two same-value senders on different accounts compete for the receipt.
  const [a, b] = pair();
  const c = statement('c');
  c.account.institutionId = 'third-bank';
  c.transactions = [txn('c', { description: 'Other out', kind: 'transfer-out', amount: -500 })];
  const forward = consolidate([a, b, c]);
  assert.equal(forward.transfers.length, 0);
  assert.equal(forward.items.length, 3);
  // Two same-value receipts compete for the single sender.
  const [a2, b2] = pair();
  const d = statement('d');
  d.account.institutionId = 'third-bank';
  d.transactions = [txn('d', { description: 'Other in', kind: 'transfer-in', amount: 500 })];
  const reverse = consolidate([a2, b2, d]);
  assert.equal(reverse.transfers.length, 0);
  assert.equal(reverse.items.length, 3);
});

test('ownership evidence still settles first; a linked number pair yields exactly one record', () => {
  // Each leg names the other account, exactly like the own-account fixtures.
  const [a, b] = pair({ counterparty: '7770001' }, { counterparty: '007770002' });
  a.account.number = '7770001';
  b.account.number = '007770002';
  const r = consolidate([a, b]);
  assert.equal(r.items.length, 0);
  assert.equal(r.transfers.length, 1);
  assert.equal(r.transfers[0].matchStatus, 'matched');
});

test('currency-exchange legs are not received transfers and do not join the value fallback', () => {
  const [a, b] = pair({ kind: 'fx', amount: 500 }, { kind: 'transfer-out', amount: -500 });
  const r = consolidate([a, b]);
  assert.equal(r.transfers.filter(t => t.matchStatus === 'matched').length, 0);
  assert.equal(r.exchanges.filter(e => e.matchStatus === 'matched').length, 0);
  assert.equal(r.items.length, 1); // the unlinked sender debit
  assert.equal(r.exchanges.length, 1); // the receipt stays an unmatched exchange record
});

test('startup upgrade re-reconciles saved sources with the value rule, removing the old financial rows', async () => {
  const { q, sql } = setup();
  try {
    const [a, b] = pair(
      { description: 'CARGA TRANSFERENCIA BANCARIA 23006326', currency: 'USD', amount: 750, kind: 'transfer-in' },
      { description: 'DEB. CAMBIOSST....123456', currency: 'USD', amount: -750, kind: 'transfer-out' },
    );
    const current = consolidate([a, b]);
    assert.equal(current.items.length, 0);
    assert.equal(current.transfers[0].matchStatus, 'matched');
    assert.equal(current.transfers[0].fromAccountId, 'a');
    // Reproduce the pre-value-rule view: both legs were financial items.
    const legacy = { ...current, transfers: [], items: [
      { id: 'legacy-a', accountId: 'a', accountLabel: a.account.name, date: a.transactions[0].date,
        description: a.transactions[0].description, amount: -750, currency: 'USD', category: 'transfer-out' as const, sourceFiles: [a.file] },
      { id: 'legacy-b', accountId: 'b', accountLabel: b.account.name, date: b.transactions[0].date,
        description: b.transactions[0].description, amount: 750, currency: 'USD', category: 'transfer-in' as const, sourceFiles: [b.file] },
    ] };
    q.saveConsolidation(legacy, [a, b]);
    const frozen = JSON.stringify(q.getConsolidated(legacy.runId));
    sql.exec('DELETE FROM transactions WHERE reconciled = 1');
    for (const [id, accountId, amount] of [['old-a', 'a', -750], ['old-b', 'b', 750]] as const) {
      sql.prepare(`INSERT INTO transactions (id, account_id, date, description, amount, currency, source, imported_at, reconciled)
        VALUES (?, ?, ?, ?, ?, 'USD', 'file-upload', ?, 0)`)
        .run(id, accountId, date('2026-09-10').toISOString(), accountId === 'a' ? 'DEB. CAMBIOSST....123456' : 'CARGA TRANSFERENCIA BANCARIA 23006326',
          amount, new Date().toISOString());
    }
    sql.prepare('UPDATE consolidation_state SET result_json = ?, reconciliation_version = 3').run(JSON.stringify(legacy));
    const reopened = new DatabaseQueries(sql);
    const app = createApp(reopened);
    const currentView = reopened.getConsolidated()!;
    assert.equal(currentView.items.length, 0);
    assert.equal(currentView.transfers[0].matchStatus, 'matched');
    assert.equal((await (await app.request('/api/transactions')).json()).length, 0);
    assert.equal(JSON.stringify(reopened.getConsolidated(legacy.runId)), frozen);
    const after = JSON.stringify(reopened.getConsolidated());
    assert.equal(JSON.stringify(new DatabaseQueries(sql).getConsolidated()), after, 'upgrade is idempotent');
  } finally { sql.close(); }
});

test('historical reports exclude newly value-matched legs without rewriting snapshots', async () => {
  const { q, sql } = setup();
  try {
    const [a, b] = pair();
    const oldRun = consolidate([a, b]);
    oldRun.items = [
      { ...a.transactions[0], id: 'old-a', accountLabel: a.account.name, category: 'expense' as const, sourceFiles: [a.file] },
      { ...b.transactions[0], id: 'old-b', accountLabel: b.account.name, category: 'income' as const, sourceFiles: [b.file] },
    ];
    q.saveConsolidation(oldRun, [a, b]);
    const frozen = JSON.stringify(q.getConsolidated(oldRun.runId));
    assert.deepEqual(q.getConsolidatedReport(oldRun.runId)!.items, []);
    assert.equal(JSON.stringify(q.getConsolidated(oldRun.runId)), frozen);
  } finally { sql.close(); }
});
