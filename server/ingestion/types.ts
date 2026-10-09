// ─── Resilience contract ───
// Every parser wraps per-file and per-row. Any failure appends a human-readable
// Issue and continues. A file-level fatal error yields exactly one 'error' issue;
// other files still process. Parsers never throw.

export type IssueSeverity = 'info' | 'warning' | 'error';

export interface Issue {
  file: string;
  sheet?: string;
  row?: number;
  field?: string;
  raw?: string;
  severity: IssueSeverity;
  message: string;
}

// ─── Statement kinds ───

export type StatementKind =
  | 'itau-estado'
  | 'itau-card'
  | 'santander-umsatz'
  | 'santander-card'
  | 'ibkr-statement'
  | 'etoro-statement'
  | 'prex-estado'
  | 'unknown';

export type ParsedAccountType = 'savings' | 'checking' | 'credit' | 'investment';

export interface ParsedAccount {
  id: string;
  institutionId: string;
  institutionName: string;
  number?: string;
  name: string;
  type: ParsedAccountType;
  currency: string;
  holder?: string;
  openingBalance?: number;
  closingBalance?: number;
  balanceDate?: Date;
  periodSource?: 'statement' | 'activity';
  periodFrom?: Date;
  periodTo?: Date;
}

// Semantic tag for a raw transaction. Consolidation is driven by this + amount sign.
export type RawTxnKind =
  | 'purchase'
  | 'card-payment'
  | 'refund'
  | 'transfer-in'
  | 'transfer-out'
  | 'fx'
  | 'fee'
  | 'interest'
  | 'dividend'
  | 'withholding'
  | 'deposit'
  | 'withdrawal'
  | 'trade'
  | 'split'
  | 'other';

export interface RawTxn {
  sourceFiles?: string[];
  sourceRows?: { statement: string; index: number }[];
  accountId: string;
  date: Date;
  postDate?: Date;
  description: string;
  amount: number;
  currency: string;
  kind: RawTxnKind;
  reference?: string;
  counterparty?: string;
  /** The account's running balance reported after this row (bank statements only). */
  balanceAfter?: number;
  metadata?: Record<string, unknown>;
}

export interface ParsedPosition {
  sourceFiles?: string[];
  accountId: string;
  symbol: string;
  name?: string;
  qty: number;
  costBasis?: number;
  value?: number;
  unrealizedPl?: number;
  snapshotDate: Date;
  currency: string;
  metadata?: Record<string, unknown>;
}

export interface ParsedRealized {
  sourceFiles?: string[];
  accountId: string;
  symbol: string;
  name?: string;
  date: Date;
  qty?: number;
  proceeds?: number;
  costBasis?: number;
  realizedPl: number;
  currency: string;
  metadata?: Record<string, unknown>;
}

export interface ParsedStatement {
  kind: StatementKind;
  file: string;
  fileHash?: string;
  account: ParsedAccount;
  transactions: RawTxn[];
  positions: ParsedPosition[];
  realized: ParsedRealized[];
  summary: Record<string, number>;
  issues: Issue[];
}

// ─── Consolidation output ───

export type ConsolidatedCategory =
  | 'expense'
  | 'income'
  | 'transfer-in'
  | 'transfer-out'
  | 'internal-transfer'
  | 'fx-exchange'
  | 'investment-income'
  | 'tax'
  | 'fee'
  | 'card-payment'
  | 'other';

export interface ConsolidatedItem {
  id: string;
  accountId: string;
  accountLabel: string;
  date: Date;
  description: string;
  amount: number;
  currency: string;
  category: ConsolidatedCategory;
  reference?: string;
  metadata?: Record<string, unknown>;
  sourceFiles: string[];
}

export type MatchStatus = 'matched' | 'unmatched';

export interface ConsolidatedTransfer {
  id: string;
  kind: 'wire' | 'card' | 'internal';
  matchStatus: MatchStatus;
  fromAccountId?: string;
  fromAccountLabel: string;
  fromCurrency?: string;
  fromAmount?: number;
  fromDate?: Date;
  fromDescription?: string;
  toAccountId?: string;
  toAccountLabel: string;
  toCurrency?: string;
  toAmount?: number;
  toDate?: Date;
  toDescription?: string;
  impliedRate?: number;
  sourceFiles: string[];
}

export interface ConsolidatedExchange {
  id: string;
  matchStatus: MatchStatus;
  accountId?: string;
  accountLabel: string;
  date?: Date;
  description?: string;
  fromCurrency?: string;
  fromAmount?: number;
  toCurrency?: string;
  toAmount?: number;
  impliedRate?: number;
  sourceFiles: string[];
}

export interface ConsolidatedPosition extends ParsedPosition {
  id: string;
  accountLabel: string;
  sourceFiles: string[];
}

export interface ConsolidatedRealized extends ParsedRealized {
  id: string;
  accountLabel: string;
  sourceFiles: string[];
}

/**
 * A bank account's reported balance at a point in time: the opening balance,
 * a row's running balance, or the closing balance of one statement. One account
 * can produce several snapshots per statement; the current view keeps them all
 * and callers merge same-day snapshots from overlapping statements.
 */
export interface ConsolidatedBalance {
  id: string;
  accountId: string;
  accountLabel: string;
  date: Date;
  amount: number;
  currency: string;
  source: 'opening' | 'activity' | 'closing';
  sourceFiles: string[];
  /** Latest date of the statement this snapshot came from; newer statements win same-day conflicts. */
  statementTo?: Date;
}

export interface ConsolidatedResult {
  runId: string;
  generatedAt: Date;
  files: string[];
  items: ConsolidatedItem[];
  transfers: ConsolidatedTransfer[];
  exchanges: ConsolidatedExchange[];
  positions: ConsolidatedPosition[];
  realized: ConsolidatedRealized[];
  balances: ConsolidatedBalance[];
  issues: Issue[];
}

// ─── Ids ───

export function generateId(): string {
  return crypto.randomUUID();
}

// ─── Amount / date normalization helpers ───

/** Parse a localized amount string: "1.228,51" | "1792.68" | "-15.652,76" | "947.8" | "29,44" */
export function parseAmount(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return isFinite(raw) ? raw : null;
  let s = String(raw).trim();
  if (!s || s === '-' || s === '–') return null;
  const negative = s.startsWith('-') || s.startsWith('(') && s.endsWith(')');
  s = s.replace(/^[(-]/, '').replace(/\)$/, '');
  s = s.replace(/[\s$]/g, '');
  if (!s) return null;
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma > lastDot) {
    // comma is the decimal separator: 1.228,51 → 1228.51
    s = s.replace(/\./g, '').replace(/,/g, '.');
  } else if (lastDot > lastComma) {
    // dot is the decimal separator: 1792.68 → keep; drop thousands commas
    s = s.replace(/,/g, '');
  } else {
    // no decimal separator: dots/commas are thousands separators
    s = s.replace(/[.,]/g, '');
  }
  const n = parseFloat(s);
  if (!isFinite(n)) return null;
  return negative ? -n : n;
}

/** Excel serial date (epoch 1899-12-30) → Date. Handles whole days and fractions. */
export function excelSerialToDateString(serial: number): string | null {
  if (!isFinite(serial) || serial < 1) return null;
  const ms = Math.round((serial - 25569) * 86400 * 1000);
  const d = new Date(ms);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/**
 * Parse a statement date in any of the observed formats:
 * DD/MM/YYYY, DD/MM/YY, DD MM YY, YYYY-MM-DD, DD/MM/YYYY HH:MM:SS, "January 1, 2026".
 * Returns a local midnight Date, or null.
 */
export function parseStatementDate(raw: unknown): Date | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') {
    const s = excelSerialToDateString(raw);
    return s ? parseISODate(s) : null;
  }
  const s = String(raw).trim();
  if (!s) return null;

  let m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (m) {
    return buildDate(m[3], m[2], m[1], m[4], m[5], m[6]);
  }
  m = s.match(/^(\d{1,2})\s+(\d{1,2})\s+(\d{2,4})$/);
  if (m) {
    return buildDate(m[3], m[2], m[1]);
  }
  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (m) {
    return buildDate(m[1], m[2], m[3], m[4], m[5], m[6]);
  }
  // "January 1, 2026" / "14/09/26 19/10/26" (first token)
  const months = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
  const m2 = s.match(/^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/);
  if (m2) {
    const mi = months.indexOf(m2[1].toLowerCase());
    if (mi >= 0) {
      const d = new Date(0);
      d.setUTCFullYear(Number(m2[3]), mi, 1);
      d.setUTCDate(Number(m2[2]));
      return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    }
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function buildDate(ym: string | undefined, mon: string, day: string, hh?: string, mm?: string, ss?: string): Date | null {
  if (!ym) return null;
  let year = Number(ym);
  if (year < 100) year += year < 50 ? 2000 : 1900;
  const month = Number(mon);
  const date = Number(day);
  if (year < 1900 || year > 2100 || month < 1 || month > 12 || date < 1 || date > 31) return null;
  const d = new Date(year, month - 1, date);
  if (hh !== undefined) {
    d.setHours(Number(hh || 0), Number(mm || 0), Number(ss || 0), 0);
  }
  return d;
}

function parseISODate(s: string): Date | null {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return isNaN(d.getTime()) ? null : d;
}

/** Format a Date as YYYY-MM-DD (local). */
export function toISODate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Two dates within n calendar days of each other (same-day matches with n=0). */
export function withinDays(a: Date, b: Date, days: number): boolean {
  const dayMs = 86400000;
  const da = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
  const db = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.abs(da - db) <= days * dayMs;
}

export function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export function daysBetween(a: Date, b: Date): number {
  const da = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
  const db = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((db - da) / 86400000);
}
