import { type Database as DatabaseType } from 'better-sqlite3';
import { generateId, now } from '../../src/types/models.ts';
import type {
  Institution, Account, Transaction,
  IngestionRun, IngestionStep, BrowserSession,
  InstitutionStatus, IngestionStatus,
  StepResult, TransactionSource,
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
       (id, institution_id, name, type, currency, balance, balance_date, account_number)
       VALUES (@id, @institutionId, @name, @type, @currency, @balance, @balanceDate, @accountNumber)`
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
       (id, institution_id, name, type, currency, balance, balance_date, account_number)
       VALUES (@id, @institutionId, @name, @type, @currency, @balance, @balanceDate, @accountNumber)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         type = excluded.type,
         currency = excluded.currency,
         balance = excluded.balance,
         balance_date = excluded.balance_date,
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

    const dedupKey = this.db.prepare(
      'SELECT id FROM transactions WHERE account_id = ? AND date = ? AND description = ? AND amount = ?'
    ).get(
      txn.accountId,
      serializeDate(txn.date),
      txn.description,
      txn.amount
    ) as { id: string } | undefined;

    if (dedupKey) {
      return;
    }

    db.prepare(
      `INSERT INTO transactions
       (id, account_id, date, post_date, description, amount, currency, category, subcategory, reference, metadata, source, imported_at)
       VALUES (@id, @accountId, @date, @postDate, @description, @amount, @currency, @category, @subcategory, @reference, @metadata, @source, @importedAt)`
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
    });
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
        const balanceDate = a.closingBalance !== undefined && a.balanceDate ? a.balanceDate : a.periodTo ?? new Date();
        db.prepare(
          `INSERT INTO accounts (id, institution_id, name, type, currency, balance, balance_date, account_number)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             name = excluded.name,
             type = excluded.type,
             currency = excluded.currency,
             balance = excluded.balance,
             balance_date = excluded.balance_date,
             account_number = COALESCE(excluded.account_number, accounts.account_number)`
        ).run(
          a.id,
          a.institutionId,
          a.name,
          a.type,
          a.currency,
          a.closingBalance ?? 0,
          serializeDate(balanceDate) || new Date().toISOString(),
          a.number || null,
        );
      }

      db.prepare(
        `INSERT INTO consolidation_runs
         (id, generated_at, files, item_count, transfer_count, exchange_count, position_count, realized_count, issue_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        result.runId,
        serializeDate(result.generatedAt) || new Date().toISOString(),
        JSON.stringify(result.files),
        result.items.length,
        result.transfers.length,
        result.exchanges.length,
        result.positions.length,
        result.realized.length,
        result.issues.length,
      );

      const insItem = db.prepare(
        `INSERT INTO transactions
         (id, account_id, run_id, date, post_date, description, amount, currency, category, reference, metadata, source, imported_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'file-upload', ?)`
      );
      for (const it of result.items) {
        insItem.run(
          it.id,
          it.accountId,
          result.runId,
          serializeDate(it.date) || new Date().toISOString(),
          null,
          it.description,
          it.amount,
          it.currency,
          it.category,
          it.reference || null,
          it.metadata ? JSON.stringify(it.metadata) : null,
          serializeDate(result.generatedAt) || new Date().toISOString(),
        );
      }

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

  getLatestConsolidationRunId(): string | null {
    const row = this.db.prepare(
      'SELECT id FROM consolidation_runs ORDER BY generated_at DESC LIMIT 1'
    ).get() as { id: string } | undefined;
    return row?.id ?? null;
  }

  getConsolidated(runId?: string): ConsolidatedResult | null {
    const id = runId ?? this.getLatestConsolidationRunId();
    if (!id) return null;
    const run = this.db.prepare(
      'SELECT * FROM consolidation_runs WHERE id = ?'
    ).get(id) as Record<string, unknown> | undefined;
    if (!run) return null;

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
