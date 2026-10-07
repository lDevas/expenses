import type { ConsolidatedExchange, Transaction } from '../types/models';

export const UNCATEGORIZED = 'Uncategorized';

/** Own-account movements change location/currency, not income or spending. */
export function isFinancialTransaction(t: Pick<Transaction, 'category'>): boolean {
  return !['internal-transfer', 'card-payment', 'fx-exchange'].includes(t.category ?? '');
}

/** Usable FX conversion derived from the latest exchange on any account. */
export interface FxInfo {
  usdPerUyu: number;
  uyuPerUsd: number;
  date?: string;
  accountLabel?: string;
}

/**
 * Turns a stored exchange into a usable rate.
 * `impliedRate` is expressed as "to per 1 from" (e.g. UYU→USD: USD per UYU).
 */
export function fxFromExchange(ex: ConsolidatedExchange | null): FxInfo | null {
  if (!ex || !ex.impliedRate || ex.impliedRate <= 0) return null;
  if (!ex.fromCurrency || !ex.toCurrency) return null;
  if (ex.fromCurrency === 'UYU' && ex.toCurrency === 'USD') {
    return { usdPerUyu: ex.impliedRate, uyuPerUsd: 1 / ex.impliedRate, date: ex.date, accountLabel: ex.accountLabel };
  }
  if (ex.fromCurrency === 'USD' && ex.toCurrency === 'UYU') {
    return { usdPerUyu: 1 / ex.impliedRate, uyuPerUsd: ex.impliedRate, date: ex.date, accountLabel: ex.accountLabel };
  }
  return null;
}

/** Convert an amount to USD. Returns NaN when no usable rate and the currency is not USD. */
export function convertToUsd(amount: number, currency: string, fx: FxInfo | null): number {
  if (currency === 'USD') return amount;
  if (currency === 'UYU') return fx ? amount * fx.usdPerUyu : NaN;
  return NaN;
}

/** Convert an amount to UYU. Returns NaN when no usable rate and the currency is not UYU. */
export function convertToUyu(amount: number, currency: string, fx: FxInfo | null): number {
  if (currency === 'UYU') return amount;
  if (currency === 'USD') return fx ? amount * fx.uyuPerUsd : NaN;
  return NaN;
}

/** Signed totals per currency. */
export function sumByCurrency(items: Transaction[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of items) out[t.currency] = (out[t.currency] ?? 0) + t.amount;
  return out;
}

export function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

/** One category (or subcategory / collapsed "Other" bucket) aggregated over a set of transactions. */
export interface CategoryAgg {
  name: string;
  /** Sums of absolute amounts per currency. */
  perCurrency: Record<string, number>;
  /** Total normalized to USD (0 when not convertible, e.g. no FX rate). */
  usd: number;
  count: number;
  subcategories: Record<string, CategoryAgg>;
}

function buildAgg(name: string, txns: Transaction[], fx: FxInfo | null, depth = 1): CategoryAgg {
  const perCurrency: Record<string, number> = {};
  const subs = new Map<string, Transaction[]>();
  let usd = 0;

  for (const t of txns) {
    const abs = Math.abs(t.amount);
    perCurrency[t.currency] = (perCurrency[t.currency] ?? 0) + abs;
    const c = convertToUsd(abs, t.currency, fx);
    if (!isNaN(c)) usd += c;
    if (depth < 2) {
      const key = t.subcategory?.trim() || UNCATEGORIZED;
      const list = subs.get(key);
      if (list) list.push(t);
      else subs.set(key, [t]);
    }
  }

  const subcategories: Record<string, CategoryAgg> = {};
  for (const [key, list] of [...subs.entries()].sort((a, b) => b[1].length - a[1].length)) {
    subcategories[key] = buildAgg(key, list, fx, depth + 1);
  }

  return { name, perCurrency, usd, count: txns.length, subcategories };
}

/**
 * Groups transactions by `category` (falling back to "Uncategorized"), sums per currency,
 * and collapses the tail into a single "Other" bucket so charts stay readable.
 */
export function aggregateCategories(items: Transaction[], fx: FxInfo | null, topN = 10): CategoryAgg[] {
  const byCat = new Map<string, Transaction[]>();
  for (const t of items.filter(isFinancialTransaction)) {
    const key = t.category?.trim() || UNCATEGORIZED;
    const list = byCat.get(key);
    if (list) list.push(t);
    else byCat.set(key, [t]);
  }

  let all = [...byCat.entries()].map(([name, list]) => buildAgg(name, list, fx));
  all.sort((a, b) => b.usd - a.usd);

  if (all.length <= topN) return all;

  const top = all.slice(0, topN);
  const rest = all.slice(topN);
  const otherPerCurrency: Record<string, number> = {};
  for (const r of rest) {
    for (const [ccy, amt] of Object.entries(r.perCurrency)) {
      otherPerCurrency[ccy] = (otherPerCurrency[ccy] ?? 0) + amt;
    }
  }
  const other: CategoryAgg = { name: 'Other', perCurrency: otherPerCurrency, usd: 0, count: 0, subcategories: {} };
  other.usd = rest.reduce((a, r) => a + r.usd, 0);
  other.count = rest.reduce((a, r) => a + r.count, 0);
  other.subcategories = Object.fromEntries(rest.map((r) => [r.name, r] as const));
  return [...top, other];
}

/**
 * Chart-ready rows for a set of category aggregates.
 * `value` is the normalized (USD) share used by the pie, or the single-currency
 * total when no FX rate exists and only one currency is present; null when a
 * mixed-currency total cannot be computed without a rate.
 */
export interface ChartDatum {
  name: string;
  value: number | null;
  valueCurrency: string | null;
  usd: number;
  perCurrency: Record<string, number>;
  count: number;
}

export function toChartData(slices: CategoryAgg[], fx: FxInfo | null): { items: ChartDatum[]; currency: string | null } {
  const currencies = new Set<string>();
  for (const s of slices) for (const c of Object.keys(s.perCurrency)) currencies.add(c);

  let currency: string | null = null;
  if (fx) currency = 'USD';
  else if (currencies.size === 1) currency = [...currencies][0];

  const items = slices
    .filter((s) => Object.values(s.perCurrency).some((v) => v > 0))
    .map((s) => {
      let value: number | null = null;
      if (currency === 'USD') value = s.usd;
      else if (currency && s.perCurrency[currency] !== undefined) value = s.perCurrency[currency];
      return {
        name: s.name,
        value,
        valueCurrency: value !== null ? currency : null,
        usd: s.usd,
        perCurrency: s.perCurrency,
        count: s.count,
      };
    });
  items.sort((a, b) => (b.value ?? b.usd) - (a.value ?? a.usd));
  return { items, currency };
}
