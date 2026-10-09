import type {
  ConsolidatedBalance,
  ConsolidatedResult,
  ParsedStatement,
  RawTxn,
} from '../types.ts';
import { generateId, parseAmount, toISODate } from '../types.ts';
import { AccountRegistry } from '../registry.ts';
import { statementKey } from '../identity.ts';

/**
 * Bank-account balance snapshots: opening balance, each day's running balance,
 * and closing balance, taken from what the statement reports.
 *
 * Credit-card and investment accounts are excluded: cards are liabilities and
 * investment accounts are measured by positions plus broker cash elsewhere.
 *
 * Same-day rows collapse to one snapshot per statement: the highest priority
 * wins (closing > activity > opening), and among a day's running-balance rows
 * the one furthest along in the file wins — Itau ledgers are oldest-first
 * while Santander umsatz exports are newest-first, so that ordering flips.
 */
export function stepBalances(result: ConsolidatedResult, statements: ParsedStatement[], registry: AccountRegistry): void {
  const byKey = new Map(statements.map(s => [statementKey(s), s] as const));
  for (const s of statements) {
    if (s.account.id === 'unknown') continue;
    if (s.account.type !== 'savings' && s.account.type !== 'checking') continue;

    const isSavings = s.account.type === 'savings';
    const statementTo = latestDate(s);

    interface Candidate {
      date: Date | undefined;
      amount: number;
      /** closing (3) > activity (2) > opening (1) */
      priority: number;
      /** File position within the statement; only comparable between same-priority candidates. */
      rank?: number;
      source: ConsolidatedBalance['source'];
    }
    const perDay = new Map<string, Candidate>();
    const better = (a: Candidate, b: Candidate): boolean =>
      a.priority !== b.priority ? a.priority > b.priority : (a.rank ?? 0) > (b.rank ?? 0);
    const consider = (candidate: Candidate): void => {
      if (!candidate.date || !Number.isFinite(candidate.date.getTime()) || !Number.isFinite(candidate.amount)) return;
      const key = toISODate(candidate.date);
      const current = perDay.get(key);
      if (!current || better(candidate, current)) perDay.set(key, candidate);
    };

    // A savings statement is a complete calendar month even when activity omits
    // days, so its opening/closing balances date to the month bounds — the same
    // normalization the coverage layer applies to savings uploads.
    consider({ date: monthStart(isSavings, s.account.periodFrom ?? earliestDate(s)), amount: s.account.openingBalance ?? NaN, priority: 1, source: 'opening' });

    // Running balance: the typed field stamped by current parsers, or the raw
    // "saldo" column kept by older archived sources.
    for (const t of s.transactions) {
      const raw = t.metadata?.raw as Record<string, unknown> | undefined;
      const amount = t.balanceAfter ?? parseAmount(raw?.saldo);
      if (amount === null) continue;
      consider({ date: t.date, amount, priority: 2, rank: rowRank(t, s, byKey), source: 'activity' });
    }

    consider({ date: monthEnd(isSavings, s.account.balanceDate ?? s.account.periodTo ?? latestTxnDate(s)), amount: s.account.closingBalance ?? NaN, priority: 3, source: 'closing' });

    for (const c of perDay.values()) {
      if (!c.date) continue; // consider() only keeps dated candidates
      result.balances.push({
        id: generateId(),
        accountId: s.account.id,
        accountLabel: registry.label(s.account.id),
        date: c.date,
        amount: c.amount,
        currency: s.account.currency,
        source: c.source,
        sourceFiles: [s.file],
        statementTo,
      });
    }
  }
}

/** Savings balances date to full calendar months; other types keep their exact dates. */
function monthStart(savings: boolean, date: Date | undefined): Date | undefined {
  if (!date || !Number.isFinite(date.getTime())) return undefined;
  if (!savings) return date;
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function monthEnd(savings: boolean, date: Date | undefined): Date | undefined {
  if (!date || !Number.isFinite(date.getTime())) return undefined;
  if (!savings) return date;
  const end = new Date(date.getFullYear(), date.getMonth() + 1, 0);
  end.setHours(23, 59, 59, 999);
  return end;
}

/** Latest date observable in the statement — freshness for same-day conflicts. */
function latestDate(s: ParsedStatement): Date | undefined {
  let latest: Date | undefined;
  for (const date of [s.account.periodFrom, s.account.periodTo, s.account.balanceDate, ...s.transactions.map(t => t.date)]) {
    if (date && Number.isFinite(date.getTime()) && (!latest || date > latest)) latest = date;
  }
  return latest;
}

function earliestDate(s: ParsedStatement): Date | undefined {
  let earliest: Date | undefined;
  for (const date of [s.account.periodFrom, ...s.transactions.map(t => t.date)]) {
    if (date && Number.isFinite(date.getTime()) && (!earliest || date < earliest)) earliest = date;
  }
  return earliest;
}

function latestTxnDate(s: ParsedStatement): Date | undefined {
  return s.transactions.reduce<Date | undefined>((latest, t) =>
    (!latest || t.date > latest) ? t.date : latest, undefined);
}

/**
 * Row rank by file position, oriented per statement: Itau ledgers are
 * oldest-first (the last row is the day's end) while Santander umsatz exports
 * are newest-first (the first row). Provenance keys can differ from the
 * enclosing statement's key (hashless fixture sources), so fall back to the
 * enclosing statement's orientation.
 */
function rowRank(t: RawTxn, statement: ParsedStatement, byKey: Map<string, ParsedStatement>): number {
  let rank: number | undefined;
  for (const row of t.sourceRows ?? []) {
    const source = byKey.get(row.statement) ?? statement;
    const oriented = source.kind === 'santander-umsatz' ? -row.index : row.index;
    if (rank === undefined || oriented > rank) rank = oriented;
  }
  return rank ?? 0;
}
