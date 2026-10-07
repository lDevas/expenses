import type { AccountUploadCoverage, UploadDateRange } from '../../src/types/models.ts';
import { toISODate } from './types.ts';
import type { ParsedStatement } from './types.ts';

const DAY_MS = 86_400_000;
export const STALE_AFTER_DAYS = 30;
const day = (value: string) => Date.parse(`${value}T00:00:00Z`);
const shift = (value: string, days: number) => new Date(day(value) + days * DAY_MS).toISOString().slice(0, 10);

export function statementCoverage(statement: ParsedStatement): {
  from: string | null; to: string | null; basis: 'statement' | 'activity' | 'unknown';
} {
  const valid = (date: Date | undefined): date is Date => !!date && Number.isFinite(date.getTime());
  const { account } = statement;
  if (valid(account.periodFrom) && valid(account.periodTo) && account.periodFrom <= account.periodTo) {
    return {
      from: toISODate(account.periodFrom), to: toISODate(account.periodTo),
      basis: account.periodSource === 'statement' ? 'statement' : 'activity',
    };
  }
  const dates = [
    ...statement.transactions.map(t => t.date),
    ...statement.realized.map(r => r.date),
    ...statement.positions.map(p => p.snapshotDate),
  ].filter(valid).map(toISODate).sort();
  return dates.length ? { from: dates[0], to: dates[dates.length - 1], basis: 'activity' }
    : { from: null, to: null, basis: 'unknown' };
}

/** Merge inclusive intervals, including adjacent days; don't bridge missing days. */
export function mergeCoverage(ranges: UploadDateRange[]): UploadDateRange[] {
  const sorted = ranges.map(r => ({ ...r })).sort((a, b) => a.from.localeCompare(b.from));
  const merged: UploadDateRange[] = [];
  for (const range of sorted) {
    const last = merged.at(-1);
    if (last && day(range.from) <= day(last.to) + DAY_MS) {
      if (range.to > last.to) last.to = range.to;
    } else merged.push(range);
  }
  return merged;
}

/** All internal gaps, plus a trailing gap after the monthly upload grace period. */
export function coverageGaps(ranges: UploadDateRange[], today: string): AccountUploadCoverage['gaps'] {
  const gaps: AccountUploadCoverage['gaps'] = [];
  for (let i = 1; i < ranges.length; i++) {
    const from = shift(ranges[i - 1].to, 1);
    const to = shift(ranges[i].from, -1);
    gaps.push({ from, to, days: Math.round((day(to) - day(from)) / DAY_MS) + 1, kind: 'internal' });
  }
  const last = ranges.at(-1);
  if (last && day(today) - day(last.to) > STALE_AFTER_DAYS * DAY_MS) {
    gaps.push({ from: shift(last.to, 1), to: today, days: Math.round((day(today) - day(last.to)) / DAY_MS), kind: 'trailing' });
  }
  return gaps;
}
