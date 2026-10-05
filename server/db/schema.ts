import Database, { type Database as DatabaseType } from 'better-sqlite3';
import path from 'path';
import os from 'os';
import fs from 'fs';
import type {
  Institution, Account, Transaction,
  InstitutionType, InstitutionStatus,
  AccountType, TransactionSource,
} from '../../src/types/models.ts';

const DEFAULT_DB_PATH = path.join(os.homedir(), '.seville', 'data', 'seville.db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS institutions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('bank', 'brokerage', 'credit')),
  country TEXT NOT NULL,
  currency TEXT NOT NULL,
  last_sync DATETIME,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'error', 'needs-setup'))
);

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  institution_id TEXT NOT NULL REFERENCES institutions(id),
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('checking', 'savings', 'investment', 'credit', 'loan')),
  currency TEXT NOT NULL,
  balance REAL NOT NULL DEFAULT 0,
  balance_date DATETIME,
  account_number TEXT
);

CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  date DATETIME NOT NULL,
  post_date DATETIME,
  description TEXT NOT NULL,
  amount REAL NOT NULL,
  currency TEXT NOT NULL,
  category TEXT,
  subcategory TEXT,
  reference TEXT,
  metadata TEXT,
  source TEXT NOT NULL DEFAULT 'ai-ingestion' CHECK(source IN ('ai-ingestion', 'file-upload', 'manual-entry')),
  imported_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(account_id, date, description, amount)
);

CREATE TABLE IF NOT EXISTS ingestion_runs (
  id TEXT PRIMARY KEY,
  institution_id TEXT NOT NULL REFERENCES institutions(id),
  started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME,
  status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running', 'success', 'error', 'partial')),
  transactions_ingested INTEGER DEFAULT 0,
  error TEXT
);

CREATE TABLE IF NOT EXISTS ingestion_steps (
  id TEXT PRIMARY KEY,
  ingestion_run_id TEXT NOT NULL REFERENCES ingestion_runs(id),
  "order" INTEGER NOT NULL,
  action TEXT NOT NULL,
  result TEXT NOT NULL CHECK(result IN ('success', 'skipped', 'failed')),
  message TEXT,
  screenshot_path TEXT,
  llm_decision TEXT
);

CREATE TABLE IF NOT EXISTS browser_sessions (
  institution_id TEXT PRIMARY KEY,
  cookies TEXT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME
);

CREATE TABLE IF NOT EXISTS agent_configs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('bank', 'brokerage', 'credit')),
  country TEXT NOT NULL,
  currency TEXT NOT NULL,
  initial_url TEXT NOT NULL,
  steps TEXT NOT NULL,
  fallbacks TEXT,
  completion_criteria TEXT NOT NULL,
  parser TEXT CHECK(parser IN ('pdf', 'csv', 'excel', 'html')),
  parser_options TEXT
);

CREATE INDEX IF NOT EXISTS idx_transactions_account ON transactions(account_id);
CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(date);
CREATE INDEX IF NOT EXISTS idx_ingestion_run_institution ON ingestion_runs(institution_id);
`;

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

function deserializeMetadata(value: string | null | undefined): Record<string, any> | null {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function serializeMetadata(value: Record<string, any> | null | undefined): string | null {
  if (!value) return null;
  return JSON.stringify(value);
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
    type: row.type as AccountType,
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
    type: row.type as InstitutionType,
    country: row.country as string,
    currency: row.currency as string,
    lastSync: deserializeDate(row.last_sync),
    status: row.status as InstitutionStatus,
  };
}

export function initializeDatabase(dbPath?: string): DatabaseType {
  const path = dbPath || DEFAULT_DB_PATH;
  const dir = path.dirname(path);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(SCHEMA);

  return db;
}
