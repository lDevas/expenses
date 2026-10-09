import type { ParsedStatement } from './types.ts';

export interface CashSnapshot {
  amount: number;
  date: Date;
  source: 'statement' | 'activity';
}

/** Cash is not equity, position value, or margin buying power. */
export function brokerCashSnapshot(statement: ParsedStatement): CashSnapshot | null {
  if (statement.account.type !== 'investment') return null;
  const candidates: CashSnapshot[] = [];
  const add = (amount: unknown, date: Date | undefined, source: CashSnapshot['source']) => {
    if (typeof amount === 'number' && Number.isFinite(amount) && date && Number.isFinite(date.getTime())) {
      candidates.push({ amount, date, source });
    }
  };
  add(statement.account.closingBalance, statement.account.balanceDate ?? statement.account.periodTo, 'statement');
  if (statement.kind === 'ibkr-statement') {
    add(statement.summary['NAV Cash total'], statement.account.periodTo, 'statement');
  }
  if (statement.kind === 'etoro-statement') {
    // Activity may be unordered. For multiple rows at the same timestamp the
    // later source row contains the running balance after all of those events.
    for (const txn of statement.transactions) {
      if (txn.currency === statement.account.currency) add(txn.metadata?.balanceAfter, txn.date, 'activity');
    }
  }
  let latest: CashSnapshot | null = null;
  for (const candidate of candidates) {
    if (!latest || candidate.date >= latest.date) latest = candidate;
  }
  return latest;
}
