import Database, { type Database as DatabaseType } from 'better-sqlite3';
import { generateId, now } from '../../src/types/models';
import type {
  Institution, Account, Transaction,
  IngestionRun, IngestionStep, BrowserSession,
  InstitutionStatus, IngestionStatus,
  StepResult, TransactionSource,
} from '../../src/types/models';

function serializeDate(date: Date | null | undefined): string | null {
  if (date === null || date === undefined) return null;
  return date.toISOString();
}

function deserializeDate(value: string | number | Date | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value;
  if (typeof value === 'number') return new Date(value);
  return new Date(String(value));
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
    date: deserializeDate(row.date),
    postDate: deserializeDate(row.post_date),
    description: row.description as string,
    amount: row.amount as number,
    currency: row.currency as string,
    category: (row.category as string) || undefined,
    subcategory: (row.subcategory as string) || undefined,
    reference: (row.reference as string) || undefined,
    metadata: deserializeMetadata(row.metadata as string | undefined),
    source: row.source as TransactionSource,
    importedAt: deserializeDate(row.imported_at),
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
    balanceDate: deserializeDate(row.balance_date),
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
    startedAt: deserializeDate(row.started_at),
    completedAt: deserializeDate(row.completed_at),
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
}
