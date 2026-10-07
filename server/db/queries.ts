import { createHash } from 'node:crypto';
import { type Database as DatabaseType } from 'better-sqlite3';
import { coverageGaps, mergeCoverage, statementCoverage } from '../ingestion/coverage.ts';
import { consolidate } from '../ingestion/consolidation.ts';
import { fingerprint, itemFingerprint, readConsolidated, readStatement, statementKey } from '../ingestion/identity.ts';
import { toISODate } from '../ingestion/types.ts';
import { generateId, now } from '../../src/types/models.ts';
import type {
  Institution, Account, Transaction,
  IngestionRun, IngestionStep, BrowserSession,
  InstitutionStatus, IngestionStatus,
  StepResult, TransactionSource, AccountUploadCoverage, ConsolidationRunSummary,
} from '../../src/types/models.ts';
import type {
  ConsolidatedResult, ConsolidatedItem, ConsolidatedTransfer, ConsolidatedExchange,
  ParsedStatement, IssueSeverity,
} from '../ingestion/types.ts';

function serializeDate(date: Date | null | undefined): string | null {
  if (date === null || date === undefined) return null;
  return date.toISOString();
}

function deserializeDate(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value;
  if (typeof value === 'number') return new Date(value);
  return new Date(String(value));
}

/** A NOT NULL date column: a missing/invalid value means a corrupt row, not a legit null. */
function requireDate(value: unknown): Date {
  const d = deserializeDate(value);
  if (!d || isNaN(d.getTime())) throw new Error(`Invalid date value: ${JSON.stringify(value)}`);
  return d;
}

function serializeMetadata(value: Record<string, any> | null | undefined): string | null {
  if (!value) return null;
  return JSON.stringify(value);
}

function deserializeMetadata(value: string | null | undefined): Record<string, any> | null {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function mapRowToTransaction(row: Record<string, unknown>): Transaction {
  return {
    id: row.id as string,
    accountId: row.account_id as string,
    date: requireDate(row.date),
    postDate: deserializeDate(row.post_date) ?? undefined,
    description: row.description as string,
    amount: row.amount as number,
    currency: row.currency as string,
    category: (row.category as string) || undefined,
    subcategory: (row.subcategory as string) || undefined,
    reference: (row.reference as string) || undefined,
    metadata: deserializeMetadata(row.metadata as string | undefined) ?? undefined,
    source: row.source as TransactionSource,
    importedAt: requireDate(row.imported_at),
  };
}

function mapRowToAccount(row: Record<string, unknown>): Account {
  return {
    id: row.id as string,
    institutionId: row.institution_id as string,
    name: row.name as string,
    type: row.type as 'checking' | 'savings' | 'investment' | 'credit' | 'loan',
    currency: row.currency as string,
    balance: row.balance as number,
    balanceDate: requireDate(row.balance_date),
    accountNumber: (row.account_number as string) || undefined,
  };
}

function mapRowToInstitution(row: Record<string, unknown>): Institution {
  return {
    id: row.id as string,
    name: row.name as string,
    type: row.type as 'bank' | 'brokerage' | 'credit',
    country: row.country as string,
    currency: row.currency as string,
    lastSync: deserializeDate(row.last_sync),
    status: row.status as InstitutionStatus,
  };
}

function mapRowToIngestionRun(row: Record<string, unknown>): IngestionRun {
  return {
    id: row.id as string,
    institutionId: row.institution_id as string,
    startedAt: requireDate(row.started_at),
    completedAt: deserializeDate(row.completed_at) ?? undefined,
    status: row.status as IngestionStatus,
    transactionsIngested: (row.transactions_ingested as number) || 0,
    error: (row.error as string) || undefined,
    steps: [],
  };
}

function mapRowToIngestionStep(row: Record<string, unknown>): IngestionStep {
  return {
    order: row.order as number,
    action: row.action as string,
    result: row.result as StepResult,
    message: (row.message as string) || undefined,
    screenshotPath: (row.screenshot_path as string) || undefined,
    llmDecision: (row.llm_decision as string) || undefined,
  };
}

export class DatabaseQueries {
  private db: DatabaseType;

  constructor(db: DatabaseType) {
    this.db = db;
  }

  // ─── Institutions ───

  getInstitutions(): Institution[] {
    const rows = this.db.prepare(
      'SELECT * FROM institutions ORDER BY name'
    ).all() as Record<string, unknown>[];
    return rows.map(mapRowToInstitution);
  }

  getInstitution(id: string): Institution | undefined {
    const row = this.db.prepare(
      'SELECT * FROM institutions WHERE id = ?'
    ).get(id) as Record<string, unknown> | undefined;
    return row ? mapRowToInstitution(row) : undefined;
  }

  saveInstitution(inst: Institution): void {
    this.db.prepare(
      `INSERT OR REPLACE INTO institutions
       (id, name, type, country, currency, last_sync, status)
       VALUES (@id, @name, @type, @country, @currency, @lastSync, @status)`
    ).run({
      id: inst.id,
      name: inst.name,
      type: inst.type,
      country: inst.country,
      currency: inst.currency,
      lastSync: serializeDate(inst.lastSync),
      status: inst.status,
    });
  }

  updateInstitutionStatus(id: string, status: InstitutionStatus): void {
    this.db.prepare(
      'UPDATE institutions SET status = ? WHERE id = ?'
    ).run(status, id);
  }

  updateInstitutionLastSync(id: string): void {
    this.db.prepare(
      'UPDATE institutions SET last_sync = ? WHERE id = ?'
    ).run(serializeDate(now()), id);
  }

  // ─── Accounts ───

  getAccountsByInstitution(institutionId: string): Account[] {
    const rows = this.db.prepare(
      'SELECT * FROM accounts WHERE institution_id = ? ORDER BY name'
    ).all(institutionId) as Record<string, unknown>[];
    return rows.map(mapRowToAccount);
  }

  getAccount(id: string): Account | undefined {
    const row = this.db.prepare(
      'SELECT * FROM accounts WHERE id = ?'
    ).get(id) as Record<string, unknown> | undefined;
    return row ? mapRowToAccount(row) : undefined;
  }

  saveAccount(account: Account): void {
    this.db.prepare(
      `INSERT INTO accounts
       (id, institution_id, name, type, currency, balance, balance_date, account_number, balance_known)
       VALUES (@id, @institutionId, @name, @type, @currency, @balance, @balanceDate, @accountNumber, 1)`
    ).run({
      id: account.id,
      institutionId: account.institutionId,
      name: account.name,
      type: account.type,
      currency: account.currency,
      balance: account.balance,
      balanceDate: serializeDate(account.balanceDate),
      accountNumber: account.accountNumber || null,
    });
  }

  upsertAccount(account: Account): void {
    this.db.prepare(
      `INSERT INTO accounts
       (id, institution_id, name, type, currency, balance, balance_date, account_number, balance_known)
       VALUES (@id, @institutionId, @name, @type, @currency, @balance, @balanceDate, @accountNumber, 1)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         type = excluded.type,
         currency = excluded.currency,
         balance = excluded.balance,
         balance_date = excluded.balance_date,
         balance_known = 1,
         account_number = excluded.account_number`
    ).run({
      id: account.id,
      institutionId: account.institutionId,
      name: account.name,
      type: account.type,
      currency: account.currency,
      balance: account.balance,
      balanceDate: serializeDate(account.balanceDate),
      accountNumber: account.accountNumber || null,
    });
  }

  // ─── Transactions ───

  getTransactions(accountId?: string, startDate?: Date, endDate?: Date): Transaction[] {
    let sql = 'SELECT * FROM transactions';
    const params: unknown[] = [];
    const conditions: string[] = [];

    if (accountId) {
      conditions.push('account_id = ?');
      params.push(accountId);
    }
    if (startDate) {
      conditions.push('date >= ?');
      params.push(serializeDate(startDate));
    }
    if (endDate) {
      conditions.push('date <= ?');
      params.push(serializeDate(endDate));
    }

    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }

    sql += ' ORDER BY date DESC';

    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map(mapRowToTransaction);
  }

  getTransaction(id: string): Transaction | undefined {
    const row = this.db.prepare(
      'SELECT * FROM transactions WHERE id = ?'
    ).get(id) as Record<string, unknown> | undefined;
    return row ? mapRowToTransaction(row) : undefined;
  }

  saveTransaction(txn: Transaction): void {
    const db = this.db;

    const contentHash = this.computeTxnHash(txn);

    const existing = this.db.prepare(
      'SELECT id FROM transactions WHERE content_hash = ?'
    ).get(contentHash) as { id: string } | undefined;

    if (existing) {
      return;
    }

    db.prepare(
      `INSERT INTO transactions
       (id, account_id, date, post_date, description, amount, currency, category, subcategory, reference, metadata, source, imported_at, content_hash)
       VALUES (@id, @accountId, @date, @postDate, @description, @amount, @currency, @category, @subcategory, @reference, @metadata, @source, @importedAt, @contentHash)`
    ).run({
      id: txn.id,
      accountId: txn.accountId,
      date: serializeDate(txn.date),
      postDate: serializeDate(txn.postDate),
      description: txn.description,
      amount: txn.amount,
      currency: txn.currency,
      category: txn.category || null,
      subcategory: txn.subcategory || null,
      reference: txn.reference || null,
      metadata: serializeMetadata(txn.metadata),
      source: txn.source,
      importedAt: serializeDate(txn.importedAt),
      contentHash,
    });
  }

  private computeTxnHash(txn: Transaction): string {
    const data = [
      txn.accountId,
      txn.date.toISOString(),
      txn.description,
      txn.amount.toFixed(2),
      txn.currency,
      txn.reference || '',
    ].join('|');
    // Simple deterministic hash
    let hash = 0;
    for (let i = 0; i < data.length; i++) {
      const chr = data.charCodeAt(i);
      hash = ((hash << 5) - hash) + chr;
      hash |= 0;
    }
    return Math.abs(hash).toString(16);
  }

  deleteTransaction(id: string): void {
    this.db.prepare(
      'DELETE FROM transactions WHERE id = ?'
    ).run(id);
  }

  // ─── Ingestion Runs ───

  createIngestionRun(run: Omit<IngestionRun, 'steps'>): string {
    const id = run.id || generateId();
    this.db.prepare(
      `INSERT INTO ingestion_runs
       (id, institution_id, started_at, completed_at, status, transactions_ingested, error)
       VALUES (@id, @institutionId, @startedAt, @completedAt, @status, @transactionsIngested, @error)`
    ).run({
      id,
      institutionId: run.institutionId,
      startedAt: serializeDate(run.startedAt),
      completedAt: serializeDate(run.completedAt),
      status: run.status,
      transactionsIngested: run.transactionsIngested,
      error: run.error || null,
    });
    return id;
  }

  getIngestionRun(id: string): IngestionRun | undefined {
    const row = this.db.prepare(
      'SELECT * FROM ingestion_runs WHERE id = ?'
    ).get(id) as Record<string, unknown> | undefined;
    if (!row) return undefined;

    const steps = this.db.prepare(
      'SELECT * FROM ingestion_steps WHERE ingestion_run_id = ? ORDER BY "order" ASC'
    ).all(id) as Record<string, unknown>[];

    return {
      ...mapRowToIngestionRun(row),
      steps: steps.map(mapRowToIngestionStep),
    };
  }

  getLatestIngestionRun(institutionId: string): IngestionRun | null {
    const row = this.db.prepare(
      'SELECT * FROM ingestion_runs WHERE institution_id = ? ORDER BY started_at DESC LIMIT 1'
    ).get(institutionId) as Record<string, unknown> | undefined;
    if (!row) return null;

    const steps = this.db.prepare(
      'SELECT * FROM ingestion_steps WHERE ingestion_run_id = ? ORDER BY "order" ASC'
    ).all(row.id) as Record<string, unknown>[];

    return {
      ...mapRowToIngestionRun(row),
      steps: steps.map(mapRowToIngestionStep),
    };
  }

  getAllIngestionRuns(institutionId: string): IngestionRun[] {
    const rows = this.db.prepare(
      'SELECT * FROM ingestion_runs WHERE institution_id = ? ORDER BY started_at DESC'
    ).all(institutionId) as Record<string, unknown>[];

    return rows.map((row) => {
      const steps = this.db.prepare(
        'SELECT * FROM ingestion_steps WHERE ingestion_run_id = ? ORDER BY "order" ASC'
      ).all(row.id) as Record<string, unknown>[];

      return {
        ...mapRowToIngestionRun(row),
        steps: steps.map(mapRowToIngestionStep),
      };
    });
  }

  updateIngestionRunStatus(
    id: string,
    status: IngestionStatus,
    transactionsIngested?: number,
    error?: string
  ): void {
    const updates: string[] = ['status = ?'];
    const params: unknown[] = [status];

    if (transactionsIngested !== undefined) {
      updates.push('transactions_ingested = ?');
      params.push(transactionsIngested);
    }
    if (error !== undefined) {
      updates.push('error = ?');
      params.push(error || null);
    }

    updates.push('completed_at = ?');
    params.push(serializeDate(now()));

    updates.push('WHERE id = ?');
    params.push(id);

    this.db.prepare(
      `UPDATE ingestion_runs SET ${updates.join(', ')}`
    ).run(...params);
  }

  // ─── Ingestion Steps ───

  saveIngestionStep(step: Omit<IngestionStep, 'id'> & { ingestionRunId: string }): void {
    const id = generateId();
    this.db.prepare(
      `INSERT INTO ingestion_steps
       (id, ingestion_run_id, "order", action, result, message, screenshot_path, llm_decision)
       VALUES (@id, @ingestionRunId, @order, @action, @result, @message, @screenshotPath, @llmDecision)`
    ).run({
      id,
      ingestionRunId: step.ingestionRunId,
      order: step.order,
      action: step.action,
      result: step.result,
      message: step.message || null,
      screenshotPath: step.screenshotPath || null,
      llmDecision: step.llmDecision || null,
    });
  }

  getIngestionSteps(runId: string): IngestionStep[] {
    const rows = this.db.prepare(
      'SELECT * FROM ingestion_steps WHERE ingestion_run_id = ? ORDER BY "order" ASC'
    ).all(runId) as Record<string, unknown>[];
    return rows.map(mapRowToIngestionStep);
  }

  // ─── Browser Sessions ───

  saveBrowserSession(session: BrowserSession): void {
    this.db.prepare(
      `INSERT OR REPLACE INTO browser_sessions
       (institution_id, cookies, created_at, expires_at)
       VALUES (@institutionId, @cookies, @createdAt, @expiresAt)`
    ).run({
      institutionId: session.institutionId,
      cookies: JSON.stringify(session.cookies),
      createdAt: session.createdAt,
      expiresAt: session.expiresAt || null,
    });
  }

  getBrowserSession(institutionId: string): BrowserSession | null {
    const row = this.db.prepare(
      'SELECT * FROM browser_sessions WHERE institution_id = ?'
    ).get(institutionId) as Record<string, unknown> | undefined;
    if (!row) return null;

    return {
      institutionId: row.institution_id as string,
      cookies: JSON.parse(row.cookies as string),
      createdAt: row.created_at as string,
      expiresAt: (row.expires_at as string) || undefined,
    };
  }

  deleteBrowserSession(institutionId: string): void {
    this.db.prepare(
      'DELETE FROM browser_sessions WHERE institution_id = ?'
    ).run(institutionId);
  }

  listBrowserSessions(): BrowserSession[] {
    const rows = this.db.prepare(
      'SELECT * FROM browser_sessions ORDER BY created_at DESC'
    ).all() as Record<string, unknown>[];

    return rows.map((row) => ({
      institutionId: row.institution_id as string,
      cookies: JSON.parse(row.cookies as string),
      createdAt: row.created_at as string,
      expiresAt: (row.expires_at as string) || undefined,
    }));
  }

  // ─── Raw query helpers for seeding ───

  seedDefaultInstitutions(): void {
    const institutions = [
      { id: 'santander-uy', name: 'Santander Uruguay', type: 'bank' as const, country: 'UY', currency: 'UYU' },
      { id: 'itau-uy', name: 'Itau Uruguay', type: 'bank' as const, country: 'UY', currency: 'UYU' },
      { id: 'broadband-uy', name: 'Cotidiano Uruguay (Broadband)', type: 'credit' as const, country: 'UY', currency: 'UYU' },
      { id: 'blanluz-uy', name: 'Blanluz Uruguay', type: 'credit' as const, country: 'UY', currency: 'UYU' },
      { id: 'phone-uy', name: 'Telecom Uruguay', type: 'credit' as const, country: 'UY', currency: 'UYU' },
    ];

    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO institutions (id, name, type, country, currency)
       VALUES (@id, @name, @type, @country, @currency)`
    );

    const tx = this.db.transaction(() => {
      for (const inst of institutions) {
        insert.run(inst);
      }
    });
    tx();
  }

  getDatabasePath(): string {
    return this.db.name;
  }

  // ─── Consolidation (file-upload pipeline) ───

  saveConsolidation(result: ConsolidatedResult, statements: ParsedStatement[]): void {
    const db = this.db;
    const tx = db.transaction(() => {
      // upsert institutions + accounts discovered in the statements
      for (const s of statements) {
        const a = s.account;
        if (a.id === 'unknown') continue;
        const institutionType = a.type === 'investment' ? 'brokerage' : a.type === 'credit' ? 'credit' : 'bank';
        const country = /itau|santander/.test(a.institutionId) ? 'UY' : 'US';
        db.prepare(
          `INSERT OR IGNORE INTO institutions (id, name, type, country, currency)
           VALUES (?, ?, ?, ?, ?)`
        ).run(a.institutionId, a.institutionName, institutionType, country, a.currency);
        const balanceDate = a.balanceDate ?? a.periodTo;
        const validBalance = Number.isFinite(a.closingBalance) && balanceDate instanceof Date && Number.isFinite(balanceDate.getTime());
        db.prepare(
          `INSERT INTO accounts (id, institution_id, name, type, currency, balance, balance_date, account_number, balance_known)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             name = excluded.name,
             type = excluded.type,
             currency = excluded.currency,
             balance = CASE WHEN excluded.balance_known = 1 AND (accounts.balance_known = 0 OR excluded.balance_date >= accounts.balance_date)
               THEN excluded.balance ELSE accounts.balance END,
             balance_date = CASE WHEN excluded.balance_known = 1 AND (accounts.balance_known = 0 OR excluded.balance_date >= accounts.balance_date)
               THEN excluded.balance_date ELSE accounts.balance_date END,
             balance_known = MAX(accounts.balance_known, excluded.balance_known),
             account_number = COALESCE(excluded.account_number, accounts.account_number)`
        ).run(
          a.id,
          a.institutionId,
          a.name,
          a.type,
          a.currency,
          validBalance ? a.closingBalance : 0,
          validBalance ? serializeDate(balanceDate) : new Date(0).toISOString(),
          a.number || null,
          validBalance ? 1 : 0,
        );
      }

      const fileHash = createHash('sha256').update(JSON.stringify(statements.map(s => s.fileHash ?? s.file).sort())).digest('hex');
      db.prepare(
        `INSERT INTO consolidation_runs
         (id, generated_at, files, file_hash, item_count, transfer_count, exchange_count, position_count, realized_count, issue_count, result_json, sources_saved)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
      ).run(
        result.runId,
        serializeDate(result.generatedAt) || new Date().toISOString(),
        JSON.stringify(result.files),
        fileHash,
        result.items.length,
        result.transfers.length,
        result.exchanges.length,
        result.positions.length,
        result.realized.length,
        result.issues.length,
        JSON.stringify(result),
      );

      const insUpload = db.prepare(`INSERT INTO account_upload_files
        (id, account_id, run_id, file_name, file_hash, min_date, max_date, basis)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const statement of statements) {
        if (statement.account.id === 'unknown') continue;
        const range = statementCoverage(statement);
        insUpload.run(generateId(), statement.account.id, result.runId, statement.file,
          statement.fileHash ?? null, range.from, range.to, range.basis);
      }

      // Validate the supplied run before persisting its immutable snapshot.
      for (const item of result.items) {
        if (!db.prepare('SELECT 1 FROM accounts WHERE id = ?').get(item.accountId)) {
          throw new Error('FOREIGN KEY constraint failed: unknown item account');
        }
      }
      this.reconcileSources(result, statements);

      const insTransfer = db.prepare(
        `INSERT INTO consolidation_transfers
         (id, run_id, kind, match_status, from_account_id, from_label, from_currency, from_amount, from_date, from_description,
          to_account_id, to_label, to_currency, to_amount, to_date, to_description, implied_rate, source_files)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const t of result.transfers) {
        insTransfer.run(
          t.id, result.runId, t.kind, t.matchStatus,
          t.fromAccountId ?? null, t.fromAccountLabel, t.fromCurrency ?? null, t.fromAmount ?? null,
          serializeDate(t.fromDate), t.fromDescription ?? null,
          t.toAccountId ?? null, t.toAccountLabel, t.toCurrency ?? null, t.toAmount ?? null,
          serializeDate(t.toDate), t.toDescription ?? null,
          t.impliedRate ?? null, JSON.stringify(t.sourceFiles),
        );
      }

      const insExchange = db.prepare(
        `INSERT INTO consolidation_exchanges
         (id, run_id, match_status, account_id, account_label, date, description, from_currency, from_amount, to_currency, to_amount, implied_rate, source_files)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const e of result.exchanges) {
        insExchange.run(
          e.id, result.runId, e.matchStatus,
          e.accountId ?? null, e.accountLabel, serializeDate(e.date), e.description ?? null,
          e.fromCurrency ?? null, e.fromAmount ?? null, e.toCurrency ?? null, e.toAmount ?? null,
          e.impliedRate ?? null, JSON.stringify(e.sourceFiles),
        );
      }

      const insPosition = db.prepare(
        `INSERT INTO consolidation_positions
         (id, run_id, account_id, account_label, symbol, name, qty, cost_basis, value, unrealized_pl, snapshot_date, currency, metadata, source_files)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const p of result.positions) {
        insPosition.run(
          p.id, result.runId, p.accountId, p.accountLabel, p.symbol, p.name ?? null,
          p.qty, p.costBasis ?? null, p.value ?? null, p.unrealizedPl ?? null,
          serializeDate(p.snapshotDate), p.currency,
          p.metadata ? JSON.stringify(p.metadata) : null, JSON.stringify(p.sourceFiles),
        );
      }

      const insRealized = db.prepare(
        `INSERT INTO consolidation_realized
         (id, run_id, account_id, account_label, symbol, name, date, qty, proceeds, cost_basis, realized_pl, currency, metadata, source_files)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const r of result.realized) {
        insRealized.run(
          r.id, result.runId, r.accountId, r.accountLabel, r.symbol, r.name ?? null,
          serializeDate(r.date), r.qty ?? null, r.proceeds ?? null, r.costBasis ?? null,
          r.realizedPl, r.currency,
          r.metadata ? JSON.stringify(r.metadata) : null, JSON.stringify(r.sourceFiles),
        );
      }

      const insIssue = db.prepare(
        `INSERT INTO consolidation_issues (id, run_id, file, sheet, row, field, raw, severity, message)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const i of result.issues) {
        insIssue.run(
          generateId(), result.runId, i.file, i.sheet ?? null, i.row ?? null,
          i.field ?? null, i.raw ?? null, i.severity, i.message,
        );
      }
    });
    tx();
  }

  /** Called inside the upload transaction: source archive and materialized view commit together. */
  private reconcileSources(run: ConsolidatedResult, incoming: ParsedStatement[]): void {
    const db = this.db;
    const insertSource = db.prepare('INSERT OR IGNORE INTO statement_sources (source_key, statement_json) VALUES (?, ?)');
    for (const s of incoming) insertSource.run(fingerprint([statementKey(s), s.file]), JSON.stringify(s));
    const sources = (db.prepare('SELECT statement_json FROM statement_sources ORDER BY source_key').all() as { statement_json: string }[])
      .map(row => readStatement(row.statement_json));
    const current = consolidate(sources);
    current.runId = run.runId;
    current.generatedAt = run.generatedAt;
    current.files = [...new Set(current.files)];

    // Freeze pre-migration runs before replacing any of their transaction rows.
    // Raw sources cannot be recovered from old netted items. Retain unrepresented
    // legacy data, and replace it only when the source is re-uploaded or a row is
    // positively identified by its financial fields.
    const sourceHashes = new Set(sources.map(s => s.fileHash).filter(Boolean));
    const legacyRuns = db.prepare('SELECT id, files FROM consolidation_runs WHERE sources_saved = 0').all() as { id: string; files: string }[];
    const remainingLegacy: ConsolidatedResult[] = [];
    for (const legacy of legacyRuns) {
      const snapshot = this.getConsolidated(legacy.id)!;
      db.prepare('UPDATE consolidation_runs SET result_json = COALESCE(result_json, ?) WHERE id = ?').run(JSON.stringify(snapshot), legacy.id);
      const files = db.prepare('SELECT file_hash FROM account_upload_files WHERE run_id = ?').all(legacy.id) as { file_hash: string | null }[];
      const covered = files.length === (JSON.parse(legacy.files) as string[]).length && files.length > 0 && files.every(f => f.file_hash && sourceHashes.has(f.file_hash));
      if (covered) {
        db.prepare("DELETE FROM transactions WHERE run_id = ? AND source = 'file-upload' AND reconciled = 0").run(legacy.id);
      } else remainingLegacy.push(snapshot);
    }

    const oldItems = db.prepare("SELECT * FROM transactions WHERE source = 'file-upload' AND reconciled = 0").all() as Record<string, unknown>[];
    if (oldItems.length) {
      const identifiable = new Set(current.items.map(itemFingerprint));
      // Include single-source items that disappear when a later upload supplies
      // their counterpart (e.g. card payments) or condenses a reimbursement.
      for (const s of sources) for (const item of consolidate([s]).items) identifiable.add(itemFingerprint(item));
      for (const row of oldItems) {
        if (identifiable.has(itemFingerprint(mapRowToTransaction(row)))) db.prepare('DELETE FROM transactions WHERE id = ?').run(row.id);
      }
    }

    db.prepare('DELETE FROM transactions WHERE reconciled = 1').run();
    const insert = db.prepare(`INSERT INTO transactions
      (id, account_id, run_id, date, description, amount, currency, category, reference, metadata, source, imported_at, content_hash, reconciled)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'file-upload', ?, ?, 1)`);
    const occurrences = new Map<string, number>();
    for (const item of current.items) {
      const base = itemFingerprint(item);
      const ordinal = occurrences.get(base) ?? 0;
      occurrences.set(base, ordinal + 1);
      const identity = fingerprint([base, ordinal]);
      item.id = `statement-${identity}`;
      insert.run(item.id, item.accountId, run.runId, serializeDate(item.date), item.description,
        item.amount, item.currency, item.category, item.reference ?? null, serializeMetadata(item.metadata),
        serializeDate(run.generatedAt), identity);
    }

    const retained = db.prepare("SELECT t.*, a.name AS account_label FROM transactions t JOIN accounts a ON a.id = t.account_id WHERE t.source = 'file-upload' AND t.reconciled = 0").all() as Record<string, unknown>[];
    for (const row of retained) current.items.push({ ...mapRowToTransaction(row),
      accountLabel: row.account_label as string, category: (row.category || 'other') as ConsolidatedItem['category'], sourceFiles: [],
    });
    // Recover old rounded rates from their saved amounts. Freshly reconciled
    // rates already use raw precision, so do not recalculate those from rounded
    // output amounts. Historical JSON was frozen above and remains unchanged.
    for (const legacy of remainingLegacy) for (const exchange of legacy.exchanges) {
      if ((exchange.fromAmount ?? 0) > 0 && (exchange.toAmount ?? 0) > 0) {
        exchange.impliedRate = exchange.toAmount! / exchange.fromAmount!;
      }
    }
    // Retain legacy investments/transfers without counting repeated historical
    // uploads twice. Occurrence-aware merging also preserves repeated positions.
    for (const field of ['transfers', 'exchanges', 'positions', 'realized'] as const) {
      const counts = new Map<string, number>();
      const key = (record: object) => {
        const fields = Object.fromEntries(Object.entries(record)
          .filter(([k]) => !['id', 'sourceFiles', 'metadata', 'name', 'accountLabel', 'fromAccountLabel', 'toAccountLabel', 'impliedRate'].includes(k))
          .sort(([a], [b]) => a.localeCompare(b)));
        return fingerprint(fields);
      };
      for (const record of current[field]) { const k = key(record); counts.set(k, (counts.get(k) ?? 0) + 1); }
      for (const legacy of remainingLegacy) {
        const seen = new Map<string, number>();
        for (const record of legacy[field]) {
          const k = key(record);
          const n = (seen.get(k) ?? 0) + 1;
          seen.set(k, n);
          if (n > (counts.get(k) ?? 0)) {
            // The field and record are correlated by the loop above.
            (current[field] as object[]).push(record);
            counts.set(k, n);
          }
        }
      }
    }
    if (remainingLegacy.length || retained.length) current.issues.push({ file: '(saved history)', severity: 'warning',
      message: 'Some earlier uploads have no saved parsed source. Their financial records are retained, but cannot be fully reconciled. Re-upload those statements to rebuild them accurately; historical run details will remain unchanged.',
    });
    db.prepare('INSERT INTO consolidation_state (id, result_json) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET result_json = excluded.result_json')
      .run(JSON.stringify(current));
  }

  getAccountUploadRanges(today = toISODate(new Date())): AccountUploadCoverage[] {
    const accounts = this.db.prepare(`SELECT a.*, i.name AS institution_name
      FROM accounts a JOIN institutions i ON i.id = a.institution_id
      ORDER BY i.name, a.name, a.id`).all() as Record<string, unknown>[];
    const rows = this.db.prepare(`SELECT u.*, r.generated_at FROM account_upload_files u
      JOIN consolidation_runs r ON r.id = u.run_id
      ORDER BY r.generated_at DESC, r.rowid DESC, u.rowid DESC`).all() as Record<string, unknown>[];
    return accounts.map(a => {
      const files = rows.filter(r => r.account_id === a.id);
      const ranges = mergeCoverage(files.filter(r => r.min_date && r.max_date).map(r => ({
        from: r.min_date as string, to: r.max_date as string,
      })));
      return {
        accountId: a.id as string, institutionId: a.institution_id as string,
        institutionName: a.institution_name as string, accountName: a.name as string,
        accountNumber: (a.account_number as string) || null, currency: a.currency as string,
        minDate: ranges[0]?.from ?? null, maxDate: ranges.at(-1)?.to ?? null,
        lastUploadAt: (files[0]?.generated_at as string) ?? null,
        latestRunId: (files[0]?.run_id as string) ?? null,
        fileCount: new Set(files.filter(r => r.file_name).map(r => r.file_hash ?? `${r.run_id}:${r.file_name}`)).size,
        ranges, gaps: coverageGaps(ranges, today),
        uploads: files.map(r => ({ file: r.file_name as string | null, runId: r.run_id as string,
          uploadedAt: r.generated_at as string, from: r.min_date as string | null,
          to: r.max_date as string | null, basis: r.basis as AccountUploadCoverage['uploads'][number]['basis'],
        })),
        hasInferredCoverage: files.some(r => r.basis === 'activity' || r.basis === 'legacy'),
        hasLegacyUploads: files.some(r => r.basis === 'legacy'),
      };
    });
  }

  getConsolidationRuns(): ConsolidationRunSummary[] {
    const rows = this.db.prepare('SELECT * FROM consolidation_runs ORDER BY generated_at DESC, rowid DESC')
      .all() as Record<string, unknown>[];
    return rows.map(r => ({
      runId: r.id as string, generatedAt: r.generated_at as string,
      files: JSON.parse(r.files as string) as string[],
      itemCount: r.item_count as number, transferCount: r.transfer_count as number,
      exchangeCount: r.exchange_count as number, positionCount: r.position_count as number,
      realizedCount: r.realized_count as number, issueCount: r.issue_count as number,
    }));
  }

  /** Latest FX exchange across all accounts (used to normalize UYU/USD on the Dashboard). */
  getLatestExchange(): ConsolidatedExchange | null {
    const state = this.db.prepare('SELECT result_json FROM consolidation_state WHERE id = 1').get() as { result_json: string } | undefined;
    if (state) {
      return readConsolidated(state.result_json).exchanges
        .filter(e => e.matchStatus === 'matched' && (e.impliedRate ?? 0) > 0 && ['USD/UYU', 'UYU/USD'].includes(`${e.fromCurrency}/${e.toCurrency}`))
        .sort((a, b) => (b.date?.getTime() ?? 0) - (a.date?.getTime() ?? 0))[0] ?? null;
    }
    const row = this.db.prepare(
      `SELECT * FROM consolidation_exchanges
       WHERE implied_rate IS NOT NULL AND implied_rate > 0 AND match_status = 'matched'
         AND ((from_currency = 'USD' AND to_currency = 'UYU') OR (from_currency = 'UYU' AND to_currency = 'USD'))
       ORDER BY date DESC, rowid DESC
       LIMIT 1`
    ).get() as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: row.id as string,
      matchStatus: row.match_status as ConsolidatedExchange['matchStatus'],
      accountId: (row.account_id as string) || undefined,
      accountLabel: (row.account_label as string) || '',
      date: deserializeDate(row.date) ?? undefined,
      description: (row.description as string) || undefined,
      fromCurrency: (row.from_currency as string) || undefined,
      fromAmount: (row.from_amount as number) || undefined,
      toCurrency: (row.to_currency as string) || undefined,
      toAmount: (row.to_amount as number) || undefined,
      impliedRate: Number(row.from_amount) > 0 && Number(row.to_amount) > 0 ? Number(row.to_amount) / Number(row.from_amount) : undefined,
      sourceFiles: JSON.parse((row.source_files as string) || '[]'),
    };
  }

  getLatestConsolidationRunId(): string | null {
    const row = this.db.prepare(
      'SELECT id FROM consolidation_runs ORDER BY generated_at DESC, rowid DESC LIMIT 1'
    ).get() as { id: string } | undefined;
    return row?.id ?? null;
  }

  getConsolidated(runId?: string): ConsolidatedResult | null {
    if (!runId) {
      const state = this.db.prepare('SELECT result_json FROM consolidation_state WHERE id = 1').get() as { result_json: string } | undefined;
      if (state) return readConsolidated(state.result_json);
    }
    const id = runId ?? this.getLatestConsolidationRunId();
    if (!id) return null;
    const run = this.db.prepare(
      'SELECT * FROM consolidation_runs WHERE id = ?'
    ).get(id) as Record<string, unknown> | undefined;
    if (!run) return null;
    // Preserve the full per-run result even when its transactions were already
    // imported by an earlier batch. Financial tables still deduplicate items.
    if (run.result_json) return readConsolidated(run.result_json as string);

    const items = this.db.prepare(
      `SELECT t.*, a.name AS account_label
       FROM transactions t LEFT JOIN accounts a ON a.id = t.account_id
       WHERE t.run_id = ? ORDER BY t.date`
    ).all(id) as Record<string, unknown>[];

    const transfers = this.db.prepare(
      'SELECT * FROM consolidation_transfers WHERE run_id = ?'
    ).all(id) as Record<string, unknown>[];
    const exchanges = this.db.prepare(
      'SELECT * FROM consolidation_exchanges WHERE run_id = ?'
    ).all(id) as Record<string, unknown>[];
    const positions = this.db.prepare(
      'SELECT * FROM consolidation_positions WHERE run_id = ?'
    ).all(id) as Record<string, unknown>[];
    const realized = this.db.prepare(
      'SELECT * FROM consolidation_realized WHERE run_id = ?'
    ).all(id) as Record<string, unknown>[];
    const issues = this.db.prepare(
      'SELECT * FROM consolidation_issues WHERE run_id = ?'
    ).all(id) as Record<string, unknown>[];

    return {
      runId: id,
      generatedAt: deserializeDate(run.generated_at) ?? new Date(),
      files: JSON.parse((run.files as string) || '[]'),
      items: items.map((r) => ({
        id: r.id as string,
        accountId: r.account_id as string,
        accountLabel: ((r.account_label as string) || (r.account_id as string)),
        date: deserializeDate(r.date) ?? new Date(),
        description: r.description as string,
        amount: r.amount as number,
        currency: r.currency as string,
        category: ((r.category as string) || 'other') as ConsolidatedItem['category'],
        reference: (r.reference as string) || undefined,
        metadata: deserializeMetadata(r.metadata as string | null) ?? undefined,
        sourceFiles: [],
      })),
      transfers: transfers.map((r) => ({
        id: r.id as string,
        kind: r.kind as ConsolidatedTransfer['kind'],
        matchStatus: r.match_status as ConsolidatedTransfer['matchStatus'],
        fromAccountId: (r.from_account_id as string) || undefined,
        fromAccountLabel: (r.from_label as string) || '',
        fromCurrency: (r.from_currency as string) || undefined,
        fromAmount: (r.from_amount as number) || undefined,
        fromDate: deserializeDate(r.from_date) ?? undefined,
        fromDescription: (r.from_description as string) || undefined,
        toAccountId: (r.to_account_id as string) || undefined,
        toAccountLabel: (r.to_label as string) || '',
        toCurrency: (r.to_currency as string) || undefined,
        toAmount: (r.to_amount as number) || undefined,
        toDate: deserializeDate(r.to_date) ?? undefined,
        toDescription: (r.to_description as string) || undefined,
        impliedRate: (r.implied_rate as number) || undefined,
        sourceFiles: JSON.parse((r.source_files as string) || '[]'),
      })),
      exchanges: exchanges.map((r) => ({
        id: r.id as string,
        matchStatus: r.match_status as ConsolidatedExchange['matchStatus'],
        accountId: (r.account_id as string) || undefined,
        accountLabel: (r.account_label as string) || '',
        date: deserializeDate(r.date) ?? undefined,
        description: (r.description as string) || undefined,
        fromCurrency: (r.from_currency as string) || undefined,
        fromAmount: (r.from_amount as number) || undefined,
        toCurrency: (r.to_currency as string) || undefined,
        toAmount: (r.to_amount as number) || undefined,
        impliedRate: (r.implied_rate as number) || undefined,
        sourceFiles: JSON.parse((r.source_files as string) || '[]'),
      })),
      positions: positions.map((r) => ({
        id: r.id as string,
        accountId: (r.account_id as string) || '',
        accountLabel: (r.account_label as string) || '',
        symbol: (r.symbol as string) || '',
        name: (r.name as string) || undefined,
        qty: (r.qty as number) ?? 0,
        costBasis: (r.cost_basis as number) ?? undefined,
        value: (r.value as number) ?? undefined,
        unrealizedPl: (r.unrealized_pl as number) ?? undefined,
        snapshotDate: deserializeDate(r.snapshot_date) ?? new Date(),
        currency: (r.currency as string) || 'USD',
        metadata: deserializeMetadata(r.metadata as string | null) ?? undefined,
        sourceFiles: JSON.parse((r.source_files as string) || '[]'),
      })),
      realized: realized.map((r) => ({
        id: r.id as string,
        accountId: (r.account_id as string) || '',
        accountLabel: (r.account_label as string) || '',
        symbol: (r.symbol as string) || '',
        name: (r.name as string) || undefined,
        date: deserializeDate(r.date) ?? new Date(),
        qty: (r.qty as number) ?? undefined,
        proceeds: (r.proceeds as number) ?? undefined,
        costBasis: (r.cost_basis as number) ?? undefined,
        realizedPl: (r.realized_pl as number) ?? 0,
        currency: (r.currency as string) || 'USD',
        metadata: deserializeMetadata(r.metadata as string | null) ?? undefined,
        sourceFiles: JSON.parse((r.source_files as string) || '[]'),
      })),
      issues: issues.map((r) => ({
        file: (r.file as string) || '',
        sheet: (r.sheet as string) || undefined,
        row: (r.row as number) ?? undefined,
        field: (r.field as string) || undefined,
        raw: (r.raw as string) || undefined,
        severity: r.severity as IssueSeverity,
        message: r.message as string,
      })),
    };
  }
}
