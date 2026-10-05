import type { Database as DatabaseType } from 'better-sqlite3';

/**
 * The full database schema, shared by the API server and the CLI.
 * (Pre-dates the consolidation pipeline: the consolidation_* tables and the
 * transactions.run_id column were added for it.)
 */
export const SCHEMA_SQL = `
    CREATE TABLE IF NOT EXISTS institutions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      country TEXT NOT NULL,
      currency TEXT NOT NULL,
      last_sync TEXT,
      status TEXT NOT NULL DEFAULT 'needs-setup'
    );

    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      institution_id TEXT NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      currency TEXT NOT NULL,
      balance REAL NOT NULL DEFAULT 0,
      balance_date TEXT NOT NULL,
      account_number TEXT,
      FOREIGN KEY (institution_id) REFERENCES institutions(id)
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      run_id TEXT,
      date TEXT NOT NULL,
      post_date TEXT,
      description TEXT NOT NULL,
      amount REAL NOT NULL,
      currency TEXT NOT NULL,
      category TEXT,
      subcategory TEXT,
      reference TEXT,
      metadata TEXT,
      source TEXT NOT NULL,
      imported_at TEXT NOT NULL,
      FOREIGN KEY (account_id) REFERENCES accounts(id)
    );

    CREATE INDEX IF NOT EXISTS idx_transactions_account_id ON transactions(account_id);
    CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(date);
    CREATE INDEX IF NOT EXISTS idx_transactions_account_date ON transactions(account_id, date);

    CREATE TABLE IF NOT EXISTS ingestion_runs (
      id TEXT PRIMARY KEY,
      institution_id TEXT NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      status TEXT NOT NULL,
      transactions_ingested INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      FOREIGN KEY (institution_id) REFERENCES institutions(id)
    );

    CREATE TABLE IF NOT EXISTS ingestion_steps (
      id TEXT PRIMARY KEY,
      ingestion_run_id TEXT NOT NULL,
      "order" INTEGER NOT NULL,
      action TEXT NOT NULL,
      result TEXT NOT NULL,
      message TEXT,
      screenshot_path TEXT,
      llm_decision TEXT,
      FOREIGN KEY (ingestion_run_id) REFERENCES ingestion_runs(id)
    );

    CREATE TABLE IF NOT EXISTS browser_sessions (
      institution_id TEXT PRIMARY KEY,
      cookies TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT
    );

    CREATE TABLE IF NOT EXISTS consolidation_runs (
      id TEXT PRIMARY KEY,
      generated_at TEXT NOT NULL,
      files TEXT NOT NULL,
      item_count INTEGER NOT NULL DEFAULT 0,
      transfer_count INTEGER NOT NULL DEFAULT 0,
      exchange_count INTEGER NOT NULL DEFAULT 0,
      position_count INTEGER NOT NULL DEFAULT 0,
      realized_count INTEGER NOT NULL DEFAULT 0,
      issue_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS consolidation_transfers (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES consolidation_runs(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      match_status TEXT NOT NULL,
      from_account_id TEXT,
      from_label TEXT,
      from_currency TEXT,
      from_amount REAL,
      from_date TEXT,
      from_description TEXT,
      to_account_id TEXT,
      to_label TEXT,
      to_currency TEXT,
      to_amount REAL,
      to_date TEXT,
      to_description TEXT,
      implied_rate REAL,
      source_files TEXT
    );

    CREATE TABLE IF NOT EXISTS consolidation_exchanges (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES consolidation_runs(id) ON DELETE CASCADE,
      match_status TEXT NOT NULL,
      account_id TEXT,
      account_label TEXT,
      date TEXT,
      description TEXT,
      from_currency TEXT,
      from_amount REAL,
      to_currency TEXT,
      to_amount REAL,
      implied_rate REAL,
      source_files TEXT
    );

    CREATE TABLE IF NOT EXISTS consolidation_positions (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES consolidation_runs(id) ON DELETE CASCADE,
      account_id TEXT,
      account_label TEXT,
      symbol TEXT,
      name TEXT,
      qty REAL,
      cost_basis REAL,
      value REAL,
      unrealized_pl REAL,
      snapshot_date TEXT,
      currency TEXT,
      metadata TEXT,
      source_files TEXT
    );

    CREATE TABLE IF NOT EXISTS consolidation_realized (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES consolidation_runs(id) ON DELETE CASCADE,
      account_id TEXT,
      account_label TEXT,
      symbol TEXT,
      name TEXT,
      date TEXT,
      qty REAL,
      proceeds REAL,
      cost_basis REAL,
      realized_pl REAL,
      currency TEXT,
      metadata TEXT,
      source_files TEXT
    );

    CREATE TABLE IF NOT EXISTS consolidation_issues (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES consolidation_runs(id) ON DELETE CASCADE,
      file TEXT,
      sheet TEXT,
      row INTEGER,
      field TEXT,
      raw TEXT,
      severity TEXT NOT NULL,
      message TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_consolidation_transfers_run ON consolidation_transfers(run_id);
    CREATE INDEX IF NOT EXISTS idx_consolidation_exchanges_run ON consolidation_exchanges(run_id);
    CREATE INDEX IF NOT EXISTS idx_consolidation_positions_run ON consolidation_positions(run_id);
    CREATE INDEX IF NOT EXISTS idx_consolidation_realized_run ON consolidation_realized(run_id);
    CREATE INDEX IF NOT EXISTS idx_consolidation_issues_run ON consolidation_issues(run_id);
    CREATE INDEX IF NOT EXISTS idx_transactions_run ON transactions(run_id);
  `;

/** Apply the schema, including safe migrations for databases that predate new columns. */
export function applySchema(db: DatabaseType): void {
  db.exec(SCHEMA_SQL);

  const hasRunId = (db.prepare(`SELECT COUNT(*) AS n FROM pragma_table_info('transactions') WHERE name = 'run_id'`).get() as { n: number }).n;
  if (!hasRunId) {
    db.exec(`ALTER TABLE transactions ADD COLUMN run_id TEXT`);
  }
}
