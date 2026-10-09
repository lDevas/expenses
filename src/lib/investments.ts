import type { Account, ConsolidatedItem, ConsolidatedPosition, ConsolidatedResult, ConsolidatedTransfer } from '../types/models.ts';
import type { DateRange } from './dates.ts';

export interface PositionGroup {
  key: string;
  symbol: string;
  currency: string;
  short: boolean;
  qty: number;
  costBasis?: number;
  averageCost?: number;
  value?: number;
  unrealizedPl?: number;
  returnPct?: number;
  lots: ConsolidatedPosition[];
}

// An unavailable financial field must stay unavailable, not turn into zero.
export function completeSum(values: (number | undefined)[]): number | undefined {
  return values.length && values.every(n => typeof n === 'number' && Number.isFinite(n))
    ? values.reduce<number>((sum, n) => sum + n!, 0) : undefined;
}

export function groupPositions(positions: ConsolidatedPosition[]): PositionGroup[] {
  const groups = new Map<string, ConsolidatedPosition[]>();
  for (const p of positions) {
    const short = p.qty < 0 || /^(sell|short)$/i.test(String(p.metadata?.direction ?? ''));
    // Never net a short position against a long holding or combine currencies.
    const key = JSON.stringify([p.symbol.trim().toUpperCase(), p.currency, short]);
    const lots = groups.get(key) ?? [];
    lots.push(p);
    groups.set(key, lots);
  }
  return [...groups].map(([key, lots]) => {
    const [symbol, currency, short] = JSON.parse(key) as [string, string, boolean];
    const qty = lots.reduce((sum, p) => sum + p.qty, 0);
    const costBasis = completeSum(lots.map(p => p.costBasis));
    const value = completeSum(lots.map(p => p.value));
    const unrealizedPl = value !== undefined && costBasis !== undefined ? value - costBasis
      : completeSum(lots.map(p => p.unrealizedPl));
    return { key, symbol, currency, short, qty, costBasis, value, unrealizedPl, lots,
      averageCost: costBasis !== undefined && qty !== 0 ? Math.abs(costBasis / qty) : undefined,
      returnPct: unrealizedPl !== undefined && costBasis !== undefined && costBasis !== 0
        ? unrealizedPl / Math.abs(costBasis) * 100 : undefined,
    };
  }).sort((a, b) => a.symbol.localeCompare(b.symbol) || a.key.localeCompare(b.key));
}

export function isDividend(item: ConsolidatedItem): boolean {
  return item.category === 'investment-income' &&
    (typeof item.metadata?.gross === 'number' || /\bdividends?\b/i.test(item.description));
}

export function dividendSymbol(item: ConsolidatedItem): string {
  return String(item.metadata?.symbol || item.reference ||
    item.description.match(/^Dividend\s+([\w.-]+)/i)?.[1] ||
    item.description.match(/^([\w.-]+)\([^)]*\).*Dividend/i)?.[1] || '—');
}

export interface FundingMovement {
  transfer: ConsolidatedTransfer;
  accountLabel: string;
  counterparty: string;
  date: string;
  direction: 'Deposit' | 'Withdrawal' | 'Transfer';
  amount?: number;
  currency?: string;
  fundingDelta: number;
}

export function getInvestmentView(result: ConsolidatedResult, accounts: Account[], range: DateRange, accountId = '') {
  const ids = new Set(accounts.filter(a => a.type === 'investment' && (!accountId || a.id === accountId)).map(a => a.id));
  const from = range.from ? new Date(range.from).getTime() : NaN;
  const to = range.to ? new Date(range.to).getTime() : NaN;
  const inPeriod = (date: string) => { const time = new Date(date).getTime(); return time >= from && time <= to; };
  const latestSnapshots = new Map<string, number>();
  for (const p of result.positions) {
    const time = new Date(p.snapshotDate).getTime();
    if (ids.has(p.accountId) && time <= to && Number.isFinite(from)) {
      latestSnapshots.set(p.accountId, Math.max(latestSnapshots.get(p.accountId) ?? -Infinity, time));
    }
  }
  // Holdings are a stock as of period end; cash flows are within the period.
  // Pick the whole latest account snapshot so closed symbols don't reappear.
  const positions = groupPositions(result.positions.filter(p => ids.has(p.accountId) &&
    new Date(p.snapshotDate).getTime() === latestSnapshots.get(p.accountId)));
  const items = result.items.filter(i => ids.has(i.accountId) && inPeriod(i.date))
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  const dividends = items.filter(isDividend);
  const otherIncome = items.filter(i => ['investment-income', 'tax', 'fee'].includes(i.category) && !isDividend(i));
  const realized = result.realized.filter(r => {
    if (!ids.has(r.accountId) || !inPeriod(r.date)) return false;
    // IBKR includes opening trades in its realized export with zero P/L.
    // Retain closing trades even when they break even, including short covers.
    const codes = String(r.metadata?.code ?? '').split(';').map(code => code.trim());
    return r.realizedPl !== 0 || codes.includes('C') ||
      (!codes.includes('O') && r.metadata?.side !== 'buy');
  })
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  const funding: FundingMovement[] = [];
  for (const transfer of result.transfers) {
    if (transfer.kind !== 'wire') continue;
    const incoming = ids.has(transfer.toAccountId ?? '');
    const outgoing = ids.has(transfer.fromAccountId ?? '');
    if (!incoming && !outgoing) continue;
    const date = incoming ? transfer.toDate : transfer.fromDate;
    if (!date || !inPeriod(date)) continue;
    const amount = incoming ? transfer.toAmount : transfer.fromAmount;
    funding.push({ transfer, date, amount,
      currency: incoming ? transfer.toCurrency : transfer.fromCurrency,
      accountLabel: incoming ? transfer.toAccountLabel : transfer.fromAccountLabel,
      counterparty: incoming ? transfer.fromAccountLabel : transfer.toAccountLabel,
      direction: incoming && outgoing ? 'Transfer' : incoming ? 'Deposit' : 'Withdrawal',
      fundingDelta: incoming && outgoing ? 0 : (amount ?? 0) * (incoming ? 1 : -1),
    });
  }
  funding.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  return { positions, dividends, otherIncome, realized, funding, latestSnapshots };
}
