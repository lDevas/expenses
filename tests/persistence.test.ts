import assert from 'node:assert/strict';
import { test } from 'node:test';
import { consolidate } from '../server/ingestion/consolidation.ts';
import { DatabaseQueries } from '../server/db/queries.ts';
import { applySchema } from '../server/db/schemaSql.ts';
import { date, pairedStatements, setup, statement, txn } from './fixtures.ts';

test('separate uploads reconcile to the same current state as a batch, without rewriting history', () => {
  const batch = setup(), sequential = setup();
  try {
    const sources = pairedStatements();
    batch.q.saveConsolidation(consolidate(sources), sources);
    const first = consolidate([sources[0]]);
    sequential.q.saveConsolidation(first, [sources[0]]);
    assert.equal(sequential.q.getTransactions().length, 3, 'unmatched payment is initially retained');
    const firstSnapshot = JSON.stringify(sequential.q.getConsolidated(first.runId));
    // Recreate the query object to ensure reconciliation uses persisted sources.
    const reopened = new DatabaseQueries(sequential.sql);
    for (const s of sources.slice(1)) reopened.saveConsolidation(consolidate([s]), [s]);
    const financialRows = (q: DatabaseQueries) => q.getTransactions().map(t => [t.id, t.accountId, t.date, t.amount, t.category]).sort();
    assert.deepEqual(financialRows(reopened), financialRows(batch.q));
    assert.equal(reopened.getTransactions().length, 4, 'both pairs of repeated purchases survive');
    assert.equal(reopened.getConsolidated()!.exchanges.filter(e => e.matchStatus === 'matched').length, 1);
    assert.equal(reopened.getConsolidated()!.transfers.filter(t => t.matchStatus === 'matched').length, 1);
    assert.equal(reopened.getLatestExchange()!.impliedRate, 0.025);
    assert.equal(JSON.stringify(reopened.getConsolidated(first.runId)), firstSnapshot);
    const ids = reopened.getTransactions().map(t => t.id).sort();
    reopened.saveConsolidation(consolidate(sources), sources);
    assert.deepEqual(reopened.getTransactions().map(t => t.id).sort(), ids, 'repeat upload keeps financial identities stable');
    applySchema(sequential.sql);
    assert.equal(reopened.getAccountUploadRanges().some(a => a.hasLegacyUploads), false);
  } finally { batch.sql.close(); sequential.sql.close(); }
});

test('overlapping files preserve maximum within-statement multiplicity across uploads', () => {
  const { q, sql } = setup();
  try {
    const a = statement('bank', { transactions: [txn(), txn()] });
    const b = { ...a, file: 'overlap.csv', transactions: [txn()] };
    for (const s of [a, a, b]) q.saveConsolidation(consolidate([s]), [s]);
    assert.equal(q.getTransactions().length, 2);
    const c = { ...a, file: 'new.csv', transactions: [txn(), txn(), txn()] };
    q.saveConsolidation(consolidate([c]), [c]);
    assert.equal(q.getTransactions().length, 3);
  } finally { sql.close(); }
});

test('persisted FX rates use raw precision, not rounded output amounts', () => {
  const { q, sql } = setup();
  try {
    const [bank, usd] = pairedStatements();
    bank.transactions = [txn('bank', { kind: 'fx', amount: -40000.1234, reference: 'FX' })];
    usd.transactions = [txn('usd', { kind: 'fx', amount: 1000.0049, currency: 'USD', reference: 'FX' })];
    q.saveConsolidation(consolidate([bank, usd]), [bank, usd]);
    assert.equal(q.getLatestExchange()!.impliedRate, 1000.0049 / 40000.1234);
  } finally { sql.close(); }
});

test('balance snapshots cannot regress or be erased by missing/invalid amounts or dates', () => {
  const { q, sql } = setup();
  const upload = (balance: number | undefined, at: Date | undefined, period = '2026-09-30') => {
    const s = statement();
    s.account.closingBalance = balance;
    s.account.balanceDate = at;
    s.account.periodTo = date(period);
    q.saveConsolidation(consolidate([s]), [s]);
  };
  try {
    upload(100, date('2026-09-30'));
    upload(200, date('2026-08-31'), '2026-08-31');
    upload(undefined, date('2026-10-31'));
    upload(NaN, date('2026-10-31'));
    upload(500, new Date('invalid'));
    assert.equal(q.getAccount('bank')!.balance, 100);
    assert.equal(q.getAccount('bank')!.balanceDate.getTime(), date('2026-09-30').getTime());
    upload(0, date('2026-10-31'));
    assert.equal(q.getAccount('bank')!.balance, 0, 'a valid zero is a real snapshot');
    upload(42, date('2026-11-30'));
    assert.equal(q.getAccount('bank')!.balance, 42);
  } finally { sql.close(); }
});

test('an account created without a balance accepts its first valid historical snapshot', () => {
  const { q, sql } = setup();
  try {
    const s = statement();
    q.saveConsolidation(consolidate([s]), [s]);
    s.account.closingBalance = 80;
    s.account.balanceDate = date('2020-01-01');
    q.saveConsolidation(consolidate([s]), [s]);
    assert.equal(q.getAccount('bank')!.balance, 80);
  } finally { sql.close(); }
});

test('legacy history and manual entries survive migration; re-upload replaces only identified legacy records', () => {
  const { q, sql } = setup();
  try {
    const s = statement('bank', { fileHash: 'hash-bank', transactions: [txn(), txn()] });
    const run = consolidate([s]);
    q.saveConsolidation(run, [s]);
    sql.exec('DELETE FROM statement_sources; DELETE FROM consolidation_state; UPDATE consolidation_runs SET sources_saved = 0, result_json = NULL; UPDATE transactions SET reconciled = 0');
    // Simulate the previous implementation having dropped a repeated purchase.
    sql.exec('DELETE FROM transactions WHERE rowid = (SELECT MAX(rowid) FROM transactions)');
    const original = JSON.stringify(q.getConsolidated(run.runId));
    q.saveTransaction({ id: 'manual', accountId: 'bank', date: date('2026-08-01'),
      description: 'Manual adjustment', amount: 12, currency: 'UYU', source: 'manual-entry', importedAt: new Date() });
    const other = statement('other', { transactions: [txn('other')] });
    q.saveConsolidation(consolidate([other]), [other]);
    assert.equal(q.getTransactions().length, 3, 'unrepresented legacy and manual rows are retained');
    assert.ok(q.getConsolidated()!.issues.some(i => i.message.includes('Re-upload')));
    q.saveConsolidation(consolidate([s]), [s]);
    assert.equal(q.getTransactions().length, 4, 'legacy duplicate repaired without losing manual/other data');
    assert.equal(JSON.stringify(q.getConsolidated(run.runId)), original);
    assert.equal(q.getConsolidated()!.issues.some(i => i.message.includes('Re-upload')), false);
  } finally { sql.close(); }
});

test('source archive, current view and coverage all roll back on a failed rebuild', () => {
  const { q, sql } = setup();
  try {
    const s = statement('bank', { transactions: [txn()] });
    q.saveConsolidation(consolidate([s]), [s]);
    const before = JSON.stringify(q.getConsolidated());
    const invalid = statement('other', { transactions: [txn('missing-account')] });
    // Position the failure after source persistence, inside the materialized-view insert.
    sql.exec("CREATE TRIGGER reject_new_source BEFORE INSERT ON transactions WHEN new.account_id = 'other' BEGIN SELECT RAISE(ABORT, 'test rebuild failure'); END");
    assert.throws(() => q.saveConsolidation(consolidate([invalid]), [invalid]), /test rebuild failure/);
    assert.equal(JSON.stringify(q.getConsolidated()), before);
    assert.equal(q.getConsolidationRuns().length, 1);
    assert.equal((sql.prepare('SELECT COUNT(*) n FROM statement_sources').get() as { n: number }).n, 1);
    assert.equal(q.getAccountUploadRanges().length, 1);
    assert.equal(q.getTransactions().length, 1);
  } finally { sql.close(); }
});
