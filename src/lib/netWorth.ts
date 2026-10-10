import { formatDateInput } from './dates.ts';
import { convertToUsd, matchesCurrencyFilter, type CurrencyFilterValue, type FxInfo } from './finance.ts';
import type { Account, NetWorthAccount, NetWorthReport, NetWorthSeries } from '../types/models';

/** A balance-bearing account series for either chart. */
export type NetWorthKind = 'bank' | 'investment';

const BANK_TYPES = new Set(['savings', 'checking']);
const INVESTMENT_TYPES = new Set(['investment']);

const KIND_TYPES: Record<NetWorthKind, Set<string>> = { bank: BANK_TYPES, investment: INVESTMENT_TYPES };

export const LINE_COLORS = {
  bank: '#8b5cf6',
  investment: '#3b82f6',
  total: '#10b981',
};

const CURRENCY_COLORS: Record<string, string> = {
  UYU: '#10b981',
  USD: '#3b82f6',
};

const OTHER_COLORS = ['#f59e0b', '#ec4899', '#06b6d4', '#84cc16', '#f97316', '#64748b'];

/** One chart point in a line, in that line's display currency. */
export interface NetWorthPoint {
  /** Local calendar date, yyyy-mm-dd. */
  date: string;
  value: number | null;   // null: unknown on that date (gap)
  currency: string;       // display currency of the line
  known: number;          // in-scope accounts reporting on that date
  total: number;          // in-scope accounts
}

export interface NetWorthLine {
  name: string;
  color: string;
  points: NetWorthPoint[];
}

/** Local calendar date of a serialized timestamp. */
export function localDay(iso: string): string {
  return formatDateInput(new Date(iso));
}

/**
 * Series within the dashboard filters. The account filter only narrows series
 * of the selected account's own type: picking a card account still shows all
 * bank series, picking a savings account shows only that savings account.
 */
export function scopedSeries(report: NetWorthReport, kind: NetWorthKind, selected: Account | null, currency: CurrencyFilterValue): NetWorthSeries[] {
  const types = KIND_TYPES[kind];
  const filterByAccount = selected !== null && types.has(selected.type);
  const list = kind === 'bank' ? report.banks : report.investments;
  return list.filter(s =>
    types.has(s.accountType) &&
    (!filterByAccount || s.accountId === selected!.id) &&
    matchesCurrencyFilter(s.currency, currency));
}

/**
 * Step-function value: the account's last observation on or before `day`.
 * A null amount marks an observation with an unknown value and stops the
 * carry-over, so the gap stays honest instead of pretending the old value held.
 */
export function valueAt(series: NetWorthSeries, day: string): number | null {
  let value: number | null = null;
  for (const s of series.snapshots) {
    if (localDay(s.date) > day) break;
    value = s.amount;
  }
  return value;
}

function toPoint(group: NetWorthSeries[], day: string, currency: string, convert: (amount: number, s: NetWorthSeries) => number): NetWorthPoint {
  let sum = 0;
  let known = 0;
  for (const s of group) {
    const v = valueAt(s, day);
    if (v === null) continue;
    const c = convert(v, s);
    if (!Number.isFinite(c)) continue;
    sum += c;
    known++;
  }
  return {
    date: day,
    // Any in-scope account without a known value on that date makes the total unknown.
    value: group.length === 0 || known < group.length ? null : sum,
    currency,
    known,
    total: group.length,
  };
}

function currencyColor(ccy: string, index: number): string {
  return CURRENCY_COLORS[ccy] ?? OTHER_COLORS[index % OTHER_COLORS.length];
}

function currencyOrder(currencies: string[]): string[] {
  return [...currencies].sort((a, b) => {
    const rank = (c: string) => (c === 'USD' ? 0 : c === 'UYU' ? 1 : 2);
    return rank(a) - rank(b) || a.localeCompare(b);
  });
}

/**
 * Chart lines for one kind (bank or investment). With an FX rate every series
 * converts to USD and one line is produced; without it, one line per currency.
 */
export function buildLines(label: string, kind: NetWorthKind, report: NetWorthReport, selected: Account | null, currency: CurrencyFilterValue, fx: FxInfo | null): NetWorthLine[] {
  const series = scopedSeries(report, kind, selected, currency);
  if (series.length === 0) return [];

  const days = [...new Set(series.flatMap(s => s.snapshots.map(p => localDay(p.date))))].sort();
  const base = kind === 'bank' ? LINE_COLORS.bank : LINE_COLORS.investment;
  const convertible = fx !== null && series.every(s => Number.isFinite(convertToUsd(1, s.currency, fx)));

  if (convertible && fx) {
    const points = days.map(day => toPoint(series, day, 'USD', (v, s) => convertToUsd(v, s.currency, fx)));
    return [{ name: series.length === 1 ? label : `${label} (USD)`, color: base, points }];
  }

  return currencyOrder([...new Set(series.map(s => s.currency))]).map((ccy, i) => ({
    name: `${label} (${ccy})`,
    color: i === 0 && series.every(s => s.currency === ccy) ? base : currencyColor(ccy, i),
    points: days.map(day => toPoint(series.filter(s => s.currency === ccy), day, ccy, v => v)),
  }));
}

/** Footnote for a chart: what the line values mean currency-wise. */
export function linesNote(lines: NetWorthLine[], fx: FxInfo | null): string | null {
  const currencies = [...new Set(lines.flatMap(l => l.points.map(p => p.currency)))];
  if (currencies.length === 0) return null;
  if (currencies.length === 1 && currencies[0] === 'USD' && fx) {
    return `Converted to USD at ${fx.uyuPerUsd.toFixed(2)} UYU per 1 USD.`;
  }
  if (currencies.length > 1) {
    return `Lines are per currency (${currencies.join(', ')}) — not all currencies have an exchange rate, so they are not directly comparable.`;
  }
  return null;
}

/**
 * Lay a line out on the chart's day set: one point per day, carrying the last
 * point forward (step semantics). Between the line's own dates this agrees
 * with `valueAt`, because every snapshot date is a point date. Days before the
 * first point have nothing to carry, so the value stays unknown while the
 * line's accounts still count. `days` must be sorted ascending.
 */
export function relayoutLine(line: NetWorthLine, days: string[]): NetWorthLine {
  const currency = line.points[0]?.currency ?? 'USD';
  let last: NetWorthPoint | null = null;
  let i = 0;
  const points = days.map((day) => {
    while (i < line.points.length && line.points[i].date <= day) {
      last = line.points[i];
      i++;
    }
    if (last === null) {
      return { date: day, value: null, currency, known: 0, total: line.points[0]?.total ?? 0 };
    }
    // A carried value still rests on every reporting account; a carried gap
    // keeps the gap marker's report count for the tooltip.
    return {
      date: day,
      value: last.value,
      currency,
      known: last.value === null ? last.known : last.total,
      total: last.total,
    };
  });
  return { ...line, points };
}

/**
 * Adds the combined total line to a bank + investment chart: pointwise sum,
 * only when both kinds share one display currency. Each line is laid out on
 * the shared day set so the chart draws continuous step lines, and the total
 * sums the carried values, matching what is drawn.
 */
export function buildCombinedLines(bank: NetWorthLine[], investments: NetWorthLine[]): NetWorthLine[] {
  const a = bank.filter(l => l.points.length > 0);
  const b = investments.filter(l => l.points.length > 0);
  // A total only makes sense when each kind collapsed to a single line in the
  // same display currency; per-currency fallback lines are not comparable.
  if (a.length !== 1 || b.length !== 1 || a[0].points[0].currency !== b[0].points[0].currency) {
    return [...bank, ...investments];
  }
  const [lineA, lineB] = [a[0], b[0]];
  const days = [...new Set([...lineA.points, ...lineB.points].map(p => p.date))].sort();
  const denseA = relayoutLine(lineA, days);
  const denseB = relayoutLine(lineB, days);
  const totalPoints = days.map((day, i) => {
    const pa = denseA.points[i];
    const pb = denseB.points[i];
    return {
      date: day,
      value: pa.value !== null && pb.value !== null ? pa.value + pb.value : null,
      currency: lineA.points[0].currency,
      known: pa.known + pb.known,
      total: pa.total + pb.total,
    };
  });
  return [denseA, denseB, { name: 'Total', color: LINE_COLORS.total, points: totalPoints }];
}

// ─── Card ───

export interface AccountValue {
  accountId: string;
  label: string;
  currency: string;
  amount: number | null;   // as of the period end
  asOf: string | null;     // local calendar date of the last snapshot on or before it
}

export interface NetWorthCardData {
  accounts: AccountValue[];
  /** Per original currency. amount null: at least one in-scope account of that currency is unknown. */
  perCurrency: Record<string, { amount: number | null; asOf: string | null }>;
  /** USD total, null when any in-scope account is unknown or not convertible. */
  usd: number | null;
  unknown: number;         // in-scope accounts without a known value
  unreported: NetWorthAccount[];
}

/**
 * Card values at the period end: each in-scope account's last observation on
 * or before `to`, summed per currency and (with an FX rate) into USD.
 */
export function netWorthCardData(kind: NetWorthKind, report: NetWorthReport, to: string, selected: Account | null, currency: CurrencyFilterValue, fx: FxInfo | null): NetWorthCardData {
  const day = localDay(to);
  const types = KIND_TYPES[kind];
  const filterByAccount = selected !== null && types.has(selected.type);

  const list = (kind === 'bank' ? report.banks : report.investments).filter(s =>
    types.has(s.accountType) &&
    (!filterByAccount || s.accountId === selected!.id) &&
    matchesCurrencyFilter(s.currency, currency));

  const accounts: AccountValue[] = list.map((s) => {
    let amount: number | null = null;
    let asOf: string | null = null;
    for (const p of s.snapshots) {
      if (localDay(p.date) > day) break;
      asOf = localDay(p.date);
      amount = p.amount;
    }
    return { accountId: s.accountId, label: s.accountLabel, currency: s.currency, amount, asOf };
  });

  const perCurrency: Record<string, { amount: number | null; asOf: string | null }> = {};
  for (const ccy of currencyOrder([...new Set(list.map(s => s.currency))])) {
    const group = accounts.filter(a => a.currency === ccy);
    const known = group.filter(a => a.amount !== null);
    perCurrency[ccy] = {
      amount: group.length === 0 || known.length < group.length ? null : known.reduce((sum, a) => sum + (a.amount ?? 0), 0),
      asOf: known.length ? [...known.map(a => a.asOf)].filter((d): d is string => d !== null).sort().at(-1)! : null,
    };
  }

  let usd: number | null = null;
  if (fx) {
    const converted: number[] = [];
    let allConvertible = true;
    for (const a of accounts) {
      const c = a.amount === null ? NaN : convertToUsd(a.amount, a.currency, fx);
      if (!Number.isFinite(c)) allConvertible = false;
      converted.push(c);
    }
    if (allConvertible) usd = accounts.length ? converted.reduce((sum, c) => sum + (Number.isFinite(c) ? c : 0), 0) : null;
  }

  const unreported = report.unreported.filter(u =>
    types.has(u.accountType) &&
    (!filterByAccount || u.accountId === selected!.id) &&
    matchesCurrencyFilter(u.currency, currency));

  return {
    accounts,
    perCurrency,
    usd,
    unknown: accounts.filter(a => a.amount === null).length,
    unreported,
  };
}
