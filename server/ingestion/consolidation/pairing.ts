import type { Issue, ParsedStatement, RawTxn } from '../types.ts';
import { daysBetween, withinDays } from '../types.ts';
import type { RegistryAccount } from '../registry.ts';
import { isOwnAccountNumber, OWN_ACCOUNT_NUMBERS } from '../registry.ts';

/** A raw txn plus the context consolidation needs. */
export interface CtxTxn {
  txn: RawTxn;
  file: string;
  statement: ParsedStatement;
  account: RegistryAccount;
  consumed: boolean;
}

export function ctxOf(s: ParsedStatement, account: RegistryAccount, t: RawTxn): CtxTxn {
  return { txn: t, file: s.file, statement: s, account, consumed: false };
}

/**
 * Pair two "movement" rows (transfers / card payments / wires):
 * same institution, same currency, equal magnitude, within the date window.
 * Each row may be consumed at most once.
 */
export function findPair(
  a: CtxTxn,
  candidates: CtxTxn[],
  opts: { windowDays: number; tolerance: number },
): CtxTxn | null {
  if (a.consumed) return null;
  let best: CtxTxn | null = null;
  let bestDelta = Infinity;
  for (const b of candidates) {
    if (b === a || b.consumed) continue;
    if (b.account.id === a.account.id) continue;
    if (b.account.institutionId !== a.account.institutionId) continue;
    if (b.txn.currency !== a.txn.currency) continue;
    const magA = Math.abs(a.txn.amount);
    const magB = Math.abs(b.txn.amount);
    if (Math.abs(magA - magB) > opts.tolerance) continue;
    if (!withinDays(a.txn.date, b.txn.date, opts.windowDays)) continue;
    const delta = Math.abs(daysBetween(a.txn.date, b.txn.date));
    if (delta < bestDelta) {
      best = b;
      bestDelta = delta;
    }
  }
  return best;
}

export function consumePair(a: CtxTxn, b: CtxTxn | null): void {
  a.consumed = true;
  if (b) b.consumed = true;
}

export { isOwnAccountNumber, OWN_ACCOUNT_NUMBERS };
export type { Issue };
