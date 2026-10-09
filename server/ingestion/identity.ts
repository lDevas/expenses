import { createHash } from 'node:crypto';
import type { ConsolidatedItem, ConsolidatedResult, ParsedStatement } from './types.ts';

export function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function statementKey(s: ParsedStatement): string {
  return fingerprint([s.kind, s.account.id, s.fileHash ?? {
    account: s.account, transactions: s.transactions, positions: s.positions, realized: s.realized,
  }]);
}

export function itemFingerprint(item: Pick<ConsolidatedItem, 'accountId' | 'date' | 'description' | 'amount' | 'currency' | 'reference'>): string {
  return fingerprint([item.accountId, item.date.toISOString(), item.description.trim().replace(/\s+/g, ' '),
    item.amount.toFixed(2), item.currency, item.reference || '']);
}

/**
 * An export without bank transaction IDs can only identify a row by its financial
 * fields and occurrence number. Keep the maximum multiplicity in any one export,
 * not one copy per fingerprint: two identical purchases in a statement are real.
 * Match only across exports, before any pairing or financial aggregation.
 */
export function deduplicateStatements(input: ParsedStatement[]): ParsedStatement[] {
  type Provenance = { sourceFiles?: string[]; sourceRows?: { statement: string; index: number }[] };
  const seen = new Map<string, Provenance>();
  return [...input].sort((a, b) => statementKey(a).localeCompare(statementKey(b)) || a.file.localeCompare(b.file)).map(s => {
    const sourceId = statementKey(s);
    const occurrences = new Map<string, number>();
    function unique<T extends Provenance>(rows: T[], kind: string, key: (row: T) => unknown): T[] {
      const out: T[] = [];
      for (const row of rows) {
        const base = fingerprint([s.account.id, kind, key(row)]);
        const ordinal = occurrences.get(base) ?? 0;
        occurrences.set(base, ordinal + 1);
        const identity = `${base}:${ordinal}`;
        const sources = row.sourceFiles ?? [s.file];
        const previous = seen.get(identity);
        if (previous) {
          previous.sourceFiles = [...new Set([...(previous.sourceFiles ?? []), ...sources])];
          if (row.sourceRows) previous.sourceRows = [...(previous.sourceRows ?? []), ...row.sourceRows];
        } else {
          const copy = { ...row, sourceFiles: [...sources] };
          seen.set(identity, copy);
          out.push(copy);
        }
      }
      return out;
    }
    return {
      ...s,
      transactions: unique(s.transactions.map((t, index) => ({ ...t, sourceRows: [{ statement: sourceId, index }] })),
        'txn', t => [t.accountId, t.date, t.description.trim().replace(/\s+/g, ' '),
          t.amount, t.currency, t.kind, t.reference || '', t.counterparty || '', t.metadata?.positionId]),
      positions: unique(s.positions, 'position', p => [p.accountId, p.snapshotDate, p.symbol, p.currency,
        p.qty, p.costBasis, p.value, p.unrealizedPl, p.metadata?.positionId]),
      realized: unique(s.realized, 'realized', r => [r.accountId, r.date, r.symbol, r.currency,
        r.qty, r.proceeds, r.costBasis, r.realizedPl, r.metadata?.positionId]),
    };
  });
}

export function readStatement(json: string): ParsedStatement {
  const s = JSON.parse(json) as ParsedStatement;
  for (const field of ['balanceDate', 'periodFrom', 'periodTo'] as const) {
    if (s.account[field]) s.account[field] = new Date(s.account[field]!);
  }
  for (const t of s.transactions) {
    t.date = new Date(t.date);
    if (t.postDate) t.postDate = new Date(t.postDate);
  }
  for (const p of s.positions) p.snapshotDate = new Date(p.snapshotDate);
  for (const r of s.realized) r.date = new Date(r.date);
  return s;
}

export function readConsolidated(json: string): ConsolidatedResult {
  const r = JSON.parse(json) as ConsolidatedResult;
  r.generatedAt = new Date(r.generatedAt);
  for (const t of r.items) t.date = new Date(t.date);
  for (const t of r.transfers) {
    if (t.fromDate) t.fromDate = new Date(t.fromDate);
    if (t.toDate) t.toDate = new Date(t.toDate);
  }
  for (const e of r.exchanges) if (e.date) e.date = new Date(e.date);
  for (const p of r.positions) p.snapshotDate = new Date(p.snapshotDate);
  for (const t of r.realized) t.date = new Date(t.date);
  if (!Array.isArray(r.balances)) r.balances = [];
  for (const b of r.balances) {
    b.date = new Date(b.date);
    if (b.statementTo) b.statementTo = new Date(b.statementTo);
  }
  return r;
}
