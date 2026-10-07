import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { applySchema } from './schemaSql.ts';
import { DatabaseQueries } from './queries.ts';
import { consolidate } from '../ingestion/consolidation.ts';
import { parseStatementDate } from '../ingestion/types.ts';
import type { ParsedStatement } from '../ingestion/types.ts';

const date = (value: string) => parseStatementDate(value)!;
function statement(account: string, from: string, to: string, hash: string, file = 'statement.csv'): ParsedStatement {
  return {
    kind: 'ibkr-statement', file, fileHash: hash,
    account: { id: account, institutionId: 'test-bank', institutionName: 'Test Bank', name: account,
      type: 'checking', currency: 'USD', periodFrom: date(from), periodTo: date(to), periodSource: 'statement' },
    transactions: [{ accountId: account, date: date(from), description: 'Purchase', amount: -5, currency: 'USD', kind: 'purchase' }],
    positions: [], realized: [], summary: {}, issues: [],
  };
}
function setup() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applySchema(db);
  return { db, queries: new DatabaseQueries(db) };
}

test('tracks each account independently, fills gaps, counts unique files and preserves duplicate run details', () => {
  const { db, queries } = setup();
  try {
    const a = statement('a', '2026-01-01', '2026-01-31', 'hash-a');
    const b = statement('b', '2026-03-01', '2026-03-31', 'hash-b', 'b.csv');
    const first = consolidate([a, b]);
    queries.saveConsolidation(first, [a, b]);
    const march = statement('a', '2026-03-01', '2026-03-31', 'hash-march');
    const second = consolidate([march]);
    queries.saveConsolidation(second, [march]);
    let coverage = queries.getAccountUploadRanges('2026-04-01');
    assert.equal(coverage[0].fileCount, 2); // Same filename, different content is not skipped.
    assert.equal(coverage[1].fileCount, 1);
    assert.deepEqual(coverage[0].gaps, [{ from: '2026-02-01', to: '2026-02-28', days: 28, kind: 'internal' }]);
    assert.equal(coverage[1].minDate, '2026-03-01');
    const february = statement('a', '2026-02-01', '2026-02-28', 'hash-feb');
    queries.saveConsolidation(consolidate([february]), [february]);
    assert.equal(queries.getAccountUploadRanges('2026-04-01')[0].gaps.length, 0);
    const repeat = consolidate([a, b]);
    queries.saveConsolidation(repeat, [a, b]);
    coverage = queries.getAccountUploadRanges('2026-04-01');
    assert.equal(coverage[0].fileCount, 3);
    assert.equal(coverage[0].latestRunId, repeat.runId);
    assert.equal(queries.getConsolidationRuns().length, 4);
    assert.equal(queries.getTransactions().length, 4); // No duplicate financial items.
    assert.equal(queries.getConsolidated(repeat.runId)!.items.length, 2);
    assert.ok(queries.getConsolidated(repeat.runId)!.items[0].date instanceof Date);
    assert.deepEqual(queries.getConsolidated(first.runId)!.files, first.files);
    assert.equal(queries.getConsolidated('missing'), null);
    applySchema(db);
    assert.equal(queries.getAccountUploadRanges('2026-04-01')[0].hasLegacyUploads, false);
  } finally { db.close(); }
});

test('unknown files stay in run history without fabricated accounts or dates', () => {
  const { db, queries } = setup();
  try {
    const s = statement('unknown', '2026-01-01', '2026-01-31', 'bad');
    s.transactions = [];
    s.kind = 'unknown';
    s.issues = [{ file: s.file, severity: 'error', message: 'Unrecognized format' }];
    const result = consolidate([s]);
    queries.saveConsolidation(result, [s]);
    assert.deepEqual(queries.getAccountUploadRanges(), []);
    assert.equal(queries.getConsolidationRuns()[0].issueCount, 1);
    assert.equal(queries.getConsolidated(result.runId)!.issues[0].message, 'Unrecognized format');
  } finally { db.close(); }
});

test('migration recovers legacy transfer/position/activity-only coverage idempotently without guessing per-account files', () => {
  const { db, queries } = setup();
  try {
    const a = statement('a', '2026-01-01', '2026-01-31', 'a');
    const b = statement('b', '2026-03-01', '2026-03-31', 'b');
    a.transactions[0].kind = 'transfer-out';
    a.transactions[0].description = 'Transfer to broker';
    b.transactions = [];
    b.positions = [{ accountId: 'b', symbol: 'X', qty: 1, snapshotDate: date('2026-03-31'), currency: 'USD' }];
    const result = consolidate([a, b]);
    queries.saveConsolidation(result, [a, b]);
    db.exec('DELETE FROM account_upload_files; UPDATE consolidation_runs SET result_json = NULL');
    applySchema(db);
    applySchema(db);
    const ranges = queries.getAccountUploadRanges('2026-04-01');
    assert.equal(ranges.length, 2);
    assert.equal(ranges[0].hasLegacyUploads, true);
    assert.equal(ranges[0].fileCount, 0);
    assert.equal(ranges[0].uploads.length, 1);
    assert.equal(ranges[0].uploads[0].file, null);
    assert.equal(ranges[0].maxDate, '2026-01-01'); // Actual activity, not a guessed full period.
    assert.equal(ranges[1].maxDate, '2026-03-31');
    assert.equal(queries.getConsolidated(result.runId)!.positions.length, 1);
  } finally { db.close(); }
});

test('range and run writes roll back together if financial persistence fails', () => {
  const { db, queries } = setup();
  try {
    const s = statement('a', '2026-01-01', '2026-01-31', 'a');
    const result = consolidate([s]);
    result.items[0].accountId = 'missing-account';
    assert.throws(() => queries.saveConsolidation(result, [s]), /FOREIGN KEY/);
    assert.deepEqual(queries.getConsolidationRuns(), []);
    assert.deepEqual(queries.getAccountUploadRanges(), []);
  } finally { db.close(); }
});

test('migrates databases missing the original consolidation columns before building their indexes', () => {
  const db = new Database(':memory:');
  try {
    db.exec(`CREATE TABLE transactions (
      id TEXT PRIMARY KEY, account_id TEXT NOT NULL, date TEXT NOT NULL,
      source TEXT NOT NULL, imported_at TEXT NOT NULL
    );
    CREATE TABLE consolidation_runs (
      id TEXT PRIMARY KEY, generated_at TEXT NOT NULL, files TEXT NOT NULL,
      item_count INTEGER DEFAULT 0, transfer_count INTEGER DEFAULT 0,
      exchange_count INTEGER DEFAULT 0, position_count INTEGER DEFAULT 0,
      realized_count INTEGER DEFAULT 0, issue_count INTEGER DEFAULT 0
    );`);
    applySchema(db);
    applySchema(db);
    const transactionColumns = db.prepare("SELECT name FROM pragma_table_info('transactions')").all() as { name: string }[];
    assert.ok(transactionColumns.some(column => column.name === 'run_id'));
    assert.ok(transactionColumns.some(column => column.name === 'content_hash'));
    const runColumns = db.prepare("SELECT name FROM pragma_table_info('consolidation_runs')").all() as { name: string }[];
    assert.ok(runColumns.some(column => column.name === 'file_hash'));
    assert.ok(runColumns.some(column => column.name === 'result_json'));
  } finally { db.close(); }
});

test('stores empty statement periods and undated uploads without inventing coverage', () => {
  const { db, queries } = setup();
  try {
    const empty = statement('a', '2026-01-01', '2026-01-31', 'empty');
    empty.transactions = [];
    const undated = statement('b', '2026-01-01', '2026-01-31', 'undated');
    undated.transactions = [];
    delete undated.account.periodFrom;
    delete undated.account.periodTo;
    const result = consolidate([empty, undated]);
    queries.saveConsolidation(result, [empty, undated]);
    const coverage = queries.getAccountUploadRanges('2026-02-01');
    assert.equal(coverage[0].maxDate, '2026-01-31');
    assert.equal(coverage[0].hasInferredCoverage, false);
    assert.equal(coverage[1].maxDate, null);
    assert.equal(coverage[1].fileCount, 1);
    assert.equal(coverage[1].uploads[0].basis, 'unknown');
    assert.deepEqual(coverage[1].gaps, []);
  } finally { db.close(); }
});
