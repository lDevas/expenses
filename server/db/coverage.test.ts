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

test('savings coverage persists full months, merges adjacent months and preserves missing months and the grace period', () => {
  const { db, queries } = setup();
  try {
    const august = statement('savings', '2026-08-05', '2026-08-27', 'august');
    august.account.type = 'savings';
    august.account.periodSource = 'activity';
    queries.saveConsolidation(consolidate([august]), [august]);
    let coverage = queries.getAccountUploadRanges('2026-09-30')[0];
    assert.equal(coverage.accountType, 'savings');
    assert.equal(coverage.minDate, '2026-08-01');
    assert.equal(coverage.maxDate, '2026-08-31');
    assert.equal(coverage.uploads[0].basis, 'activity');
    assert.deepEqual(coverage.gaps, []); // Exactly 30 days after month-end.
    assert.deepEqual(queries.getAccountUploadRanges('2026-10-01')[0].gaps,
      [{ from: '2026-09-01', to: '2026-10-01', days: 31, kind: 'trailing' }]);
    assert.deepEqual(db.prepare('SELECT min_date, max_date FROM account_upload_files').get(),
      { min_date: '2026-08-01', max_date: '2026-08-31' });

    const october = statement('savings', '2026-10-10', '2026-10-20', 'october');
    october.account.type = 'savings';
    queries.saveConsolidation(consolidate([october]), [october]);
    coverage = queries.getAccountUploadRanges('2026-10-21')[0];
    assert.deepEqual(coverage.gaps, [{ from: '2026-09-01', to: '2026-09-30', days: 30, kind: 'internal' }]);

    const september = statement('savings', '2026-09-08', '2026-09-18', 'september');
    september.account.type = 'savings';
    queries.saveConsolidation(consolidate([september]), [september]);
    coverage = queries.getAccountUploadRanges('2026-10-21')[0];
    assert.deepEqual(coverage.ranges, [{ from: '2026-08-01', to: '2026-10-31' }]);
    assert.deepEqual(coverage.gaps, []);
    assert.deepEqual(coverage.uploads.map(file => [file.from, file.to]), [
      ['2026-09-01', '2026-09-30'], ['2026-10-01', '2026-10-31'], ['2026-08-01', '2026-08-31'],
    ]);
  } finally { db.close(); }
});

test('normalizes existing savings files on read without rewriting stored coverage or financial history', () => {
  const { db, queries } = setup();
  try {
    const savings = statement('savings', '2026-08-27', '2026-08-27', 'savings');
    savings.account.type = 'savings';
    savings.account.closingBalance = 123;
    savings.account.balanceDate = date('2026-08-27');
    const credit = statement('credit', '2026-08-15', '2026-09-14', 'credit');
    credit.account.type = 'credit';
    const result = consolidate([savings, credit]);
    queries.saveConsolidation(result, [savings, credit]);
    // Recreate coverage saved by the previous version of ingestion.
    db.prepare("UPDATE account_upload_files SET min_date = '2026-08-27', max_date = '2026-08-27', basis = 'activity' WHERE account_id = 'savings'").run();
    const before = {
      files: db.prepare('SELECT * FROM account_upload_files ORDER BY id').all(),
      transactions: queries.getTransactions(),
      accounts: db.prepare('SELECT * FROM accounts ORDER BY id').all(),
      history: queries.getConsolidated(result.runId),
    };
    const coverage = queries.getAccountUploadRanges('2026-09-01');
    const normalized = coverage.find(account => account.accountId === 'savings')!;
    assert.deepEqual(normalized.ranges, [{ from: '2026-08-01', to: '2026-08-31' }]);
    assert.equal(normalized.uploads[0].from, '2026-08-01');
    assert.equal(normalized.uploads[0].to, '2026-08-31');
    assert.equal(normalized.uploads[0].basis, 'activity');
    const unchanged = coverage.find(account => account.accountId === 'credit')!;
    assert.equal(unchanged.accountType, 'credit');
    assert.deepEqual(unchanged.ranges, [{ from: '2026-08-15', to: '2026-09-14' }]);
    assert.deepEqual({
      files: db.prepare('SELECT * FROM account_upload_files ORDER BY id').all(),
      transactions: queries.getTransactions(),
      accounts: db.prepare('SELECT * FROM accounts ORDER BY id').all(),
      history: queries.getConsolidated(result.runId),
    }, before);
  } finally { db.close(); }
});

test('legacy savings activity shows full months without fabricating filenames or changing recorded activity', () => {
  const { db, queries } = setup();
  try {
    const savings = statement('savings', '2026-08-27', '2026-08-27', 'legacy');
    savings.account.type = 'savings';
    const result = consolidate([savings]);
    queries.saveConsolidation(result, [savings]);
    db.exec('DELETE FROM account_upload_files; UPDATE consolidation_runs SET result_json = NULL');
    applySchema(db);
    const before = queries.getConsolidated(result.runId);
    const coverage = queries.getAccountUploadRanges('2026-09-01')[0];
    assert.equal(coverage.hasLegacyUploads, true);
    assert.equal(coverage.fileCount, 0);
    assert.deepEqual(coverage.ranges, [{ from: '2026-08-01', to: '2026-08-31' }]);
    assert.equal(coverage.uploads[0].file, null);
    assert.equal(coverage.uploads[0].basis, 'legacy');
    assert.equal(coverage.uploads[0].from, '2026-08-01');
    assert.equal(coverage.uploads[0].to, '2026-08-31');
    assert.deepEqual(db.prepare('SELECT min_date, max_date FROM account_upload_files').get(),
      { min_date: '2026-08-27', max_date: '2026-08-27' });
    assert.deepEqual(queries.getConsolidated(result.runId), before);
  } finally { db.close(); }
});

test('undated savings uploads remain undated while empty dated statements cover full months', () => {
  const { db, queries } = setup();
  try {
    const empty = statement('empty', '2026-08-05', '2026-08-27', 'empty-savings');
    empty.account.type = 'savings';
    empty.transactions = [];
    const undated = statement('undated', '2026-08-05', '2026-08-27', 'undated-savings');
    undated.account.type = 'savings';
    undated.transactions = [];
    delete undated.account.periodFrom;
    delete undated.account.periodTo;
    queries.saveConsolidation(consolidate([empty, undated]), [empty, undated]);
    const coverage = queries.getAccountUploadRanges('2026-09-01');
    assert.equal(coverage[0].maxDate, '2026-08-31');
    assert.equal(coverage[0].uploads[0].basis, 'statement');
    assert.equal(coverage[1].minDate, null);
    assert.equal(coverage[1].maxDate, null);
    assert.deepEqual(coverage[1].ranges, []);
    assert.deepEqual(coverage[1].gaps, []);
    assert.equal(coverage[1].uploads[0].from, null);
    assert.equal(coverage[1].uploads[0].to, null);
    assert.equal(coverage[1].uploads[0].basis, 'unknown');
  } finally { db.close(); }
});
