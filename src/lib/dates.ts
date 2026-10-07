export type FilterType = 'month' | 'quarter' | 'year' | 'ytd' | 'custom';
export type DateRange = { from?: string; to?: string };

export function getMonthsLast12(now = new Date()): { value: string; label: string }[] {
  return Array.from({ length: 12 }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - 11 + i, 1);
    return { value: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
      label: d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) };
  });
}

export function getQuartersLast4(now = new Date()): { value: string; label: string }[] {
  return Array.from({ length: 4 }, (_, i) => {
    const d = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3 - (3 - i) * 3, 1);
    const quarter = Math.floor(d.getMonth() / 3) + 1;
    return { value: `${d.getFullYear()}-Q${quarter}`, label: `Q${quarter} ${d.getFullYear()}` };
  });
}

export function getYearsLast5(now = new Date()): { value: string; label: string }[] {
  return Array.from({ length: 5 }, (_, i) => String(now.getFullYear() - 4 + i)).map(year => ({ value: year, label: year }));
}

export function getDefaultFilterValue(type: FilterType, now = new Date()): string {
  if (type === 'month') return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  if (type === 'quarter') return `${now.getFullYear()}-Q${Math.floor(now.getMonth() / 3) + 1}`;
  if (type === 'year') return String(now.getFullYear());
  return type;
}

/** Date-only inputs mean a complete local calendar day, not midnight UTC. */
export function parseDateBound(value: string, endOfDay = false): Date | undefined {
  let date: Date;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split('-').map(Number);
    date = new Date(year, month - 1, day);
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return undefined;
    if (endOfDay) date.setHours(23, 59, 59, 999);
  } else date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : undefined;
}

export function getDateRangeForFilter(type: FilterType, value: string, customFrom?: string, customTo?: string, now = new Date()): DateRange {
  let from: Date | undefined;
  let to: Date | undefined;
  if (type === 'custom') {
    from = customFrom ? parseDateBound(customFrom) : undefined;
    to = customTo ? parseDateBound(customTo, true) : undefined;
  } else if (type === 'ytd') {
    from = new Date(now.getFullYear(), 0, 1);
    to = new Date(now);
    to.setHours(23, 59, 59, 999);
  } else if (type === 'month' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value)) {
    const [year, month] = value.split('-').map(Number);
    from = new Date(year, month - 1, 1);
    to = new Date(year, month, 0, 23, 59, 59, 999);
  } else if (type === 'quarter' && /^\d{4}-Q[1-4]$/.test(value)) {
    const [year, quarter] = value.split('-Q').map(Number);
    from = new Date(year, (quarter - 1) * 3, 1);
    to = new Date(year, quarter * 3, 0, 23, 59, 59, 999);
  } else if (type === 'year' && /^\d{4}$/.test(value)) {
    from = new Date(Number(value), 0, 1);
    to = new Date(Number(value), 11, 31, 23, 59, 59, 999);
  }
  return from && to && from <= to ? { from: from.toISOString(), to: to.toISOString() } : {};
}
