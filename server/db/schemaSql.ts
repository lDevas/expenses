import type { Database as DatabaseType } from 'better-sqlite3';

/**
 * The full database schema, shared by the API server and the CLI.
 * (Pre-dates the consolidation pipeline: the consolidation_* tables and the
 * transactions.run_id column were added for it.)
 */
export const SCHEMA_SQL = `
    CREATE TABLE IF NOT EXISTS user_categories (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL COLLATE NOCASE,
      direction TEXT NOT NULL CHECK(direction IN ('expense', 'income')),
      UNIQUE(name, direction)
    );
    CREATE TABLE IF NOT EXISTS category_rules (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category_id TEXT NOT NULL REFERENCES user_categories(id),
      pattern TEXT NOT NULL,
      accounting_type TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      position INTEGER NOT NULL
    );
    -- Reconciliation replaces transaction rows. Overrides must survive that rebuild.
    CREATE TABLE IF NOT EXISTS transaction_category_overrides (
      transaction_id TEXT PRIMARY KEY,
      category_id TEXT REFERENCES user_categories(id)
    );
    -- Keep explicit deletions when statement uploads rebuild transaction rows.
    CREATE TABLE IF NOT EXISTS transaction_deletions (
      transaction_id TEXT PRIMARY KEY,
      content_hash TEXT,
      deleted_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_transaction_deletions_hash ON transaction_deletions(content_hash);
    CREATE TABLE IF NOT EXISTS category_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

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
      balance_known INTEGER NOT NULL DEFAULT 0,
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
      content_hash TEXT,
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
      file_hash TEXT,
      item_count INTEGER NOT NULL DEFAULT 0,
      transfer_count INTEGER NOT NULL DEFAULT 0,
      exchange_count INTEGER NOT NULL DEFAULT 0,
      position_count INTEGER NOT NULL DEFAULT 0,
      realized_count INTEGER NOT NULL DEFAULT 0,
      issue_count INTEGER NOT NULL DEFAULT 0,
      result_json TEXT
    );

    CREATE TABLE IF NOT EXISTS account_upload_files (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id),
      run_id TEXT NOT NULL REFERENCES consolidation_runs(id) ON DELETE CASCADE,
      file_name TEXT,
      file_hash TEXT,
      min_date TEXT,
      max_date TEXT,
      basis TEXT NOT NULL CHECK(basis IN ('statement', 'activity', 'legacy', 'unknown'))
    );
    CREATE INDEX IF NOT EXISTS idx_account_upload_files_account ON account_upload_files(account_id);
    CREATE INDEX IF NOT EXISTS idx_account_upload_files_run ON account_upload_files(run_id);

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

    CREATE TABLE IF NOT EXISTS statement_sources (
      source_key TEXT PRIMARY KEY,
      statement_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS consolidation_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      result_json TEXT NOT NULL,
      reconciliation_version INTEGER NOT NULL DEFAULT 0
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

  `;

/** Apply the schema, including safe migrations for databases that predate new columns. */
export function applySchema(db: DatabaseType): void {
  db.exec(SCHEMA_SQL);

  const hasRunId = (db.prepare(`SELECT COUNT(*) AS n FROM pragma_table_info('transactions') WHERE name = 'run_id'`).get() as { n: number }).n;
  if (!hasRunId) {
    db.exec(`ALTER TABLE transactions ADD COLUMN run_id TEXT`);
  }

  const hasContentHash = (db.prepare(`SELECT COUNT(*) AS n FROM pragma_table_info('transactions') WHERE name = 'content_hash'`).get() as { n: number }).n;
  if (!hasContentHash) {
    db.exec(`ALTER TABLE transactions ADD COLUMN content_hash TEXT`);
  }

  const hasFileHash = (db.prepare(`SELECT COUNT(*) AS n FROM pragma_table_info('consolidation_runs') WHERE name = 'file_hash'`).get() as { n: number }).n;
  if (!hasFileHash) {
    db.exec(`ALTER TABLE consolidation_runs ADD COLUMN file_hash TEXT`);
  }

  const hasResult = (db.prepare(`SELECT COUNT(*) AS n FROM pragma_table_info('consolidation_runs') WHERE name = 'result_json'`).get() as { n: number }).n;
  if (!hasResult) db.exec('ALTER TABLE consolidation_runs ADD COLUMN result_json TEXT');
  const columns = (table: string) => new Set((db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all() as { name: string }[]).map(c => c.name));
  if (!columns('consolidation_state').has('reconciliation_version')) db.exec('ALTER TABLE consolidation_state ADD COLUMN reconciliation_version INTEGER NOT NULL DEFAULT 0');
  if (!columns('transactions').has('reconciled')) db.exec('ALTER TABLE transactions ADD COLUMN reconciled INTEGER NOT NULL DEFAULT 0');
  // Existing balances were previously persisted without a validity flag.
  if (!columns('accounts').has('balance_known')) db.exec('ALTER TABLE accounts ADD COLUMN balance_known INTEGER NOT NULL DEFAULT 1');
  if (!columns('consolidation_runs').has('sources_saved')) db.exec('ALTER TABLE consolidation_runs ADD COLUMN sources_saved INTEGER NOT NULL DEFAULT 0');
  db.exec('CREATE INDEX IF NOT EXISTS idx_transactions_run ON transactions(run_id)');

  // Older runs did not retain per-file statement periods. Recover only observed
  // activity bounds, including transfer-only and position-only accounts. Never
  // invent a statement period or assign every batch file to every account.
  db.exec(`
    INSERT OR IGNORE INTO account_upload_files (id, account_id, run_id, min_date, max_date, basis)
    SELECT 'legacy:' || d.account_id || ':' || d.run_id, d.account_id, d.run_id,
           MIN(substr(d.date, 1, 10)), MAX(substr(d.date, 1, 10)), 'legacy'
    FROM (
      SELECT account_id, run_id, date FROM transactions WHERE source = 'file-upload'
      UNION ALL SELECT from_account_id, run_id, from_date FROM consolidation_transfers
      UNION ALL SELECT to_account_id, run_id, to_date FROM consolidation_transfers
      UNION ALL SELECT account_id, run_id, date FROM consolidation_exchanges
      UNION ALL SELECT account_id, run_id, snapshot_date FROM consolidation_positions
      UNION ALL SELECT account_id, run_id, date FROM consolidation_realized
    ) d
    JOIN accounts a ON a.id = d.account_id
    JOIN consolidation_runs r ON r.id = d.run_id
    WHERE r.result_json IS NULL AND d.date IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM account_upload_files u WHERE u.account_id = d.account_id AND u.run_id = d.run_id
    )
    GROUP BY d.account_id, d.run_id
  `);

  // Ensure content_hash index exists
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_transactions_content_hash ON transactions(content_hash)`).run();
}
