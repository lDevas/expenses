export type FilterType = 'month' | 'year' | 'ytd' | 'custom';
export type DateRange = { from?: string; to?: string };

/** Current month, followed by the six previous complete calendar months. */
export function getRecentMonths(now = new Date()): { value: string; label: string }[] {
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    return { value: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
      label: d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) };
  });
}

export function getYearsLast5(now = new Date()): { value: string; label: string }[] {
  return Array.from({ length: 5 }, (_, i) => String(now.getFullYear() - 4 + i)).map(year => ({ value: year, label: year }));
}

export function getDefaultFilterValue(type: FilterType, now = new Date()): string {
  if (type === 'month') return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
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
  } else if (type === 'year' && /^\d{4}$/.test(value)) {
    from = new Date(Number(value), 0, 1);
    to = new Date(Number(value), 11, 31, 23, 59, 59, 999);
  }
  return from && to && from <= to ? { from: from.toISOString(), to: to.toISOString() } : {};
}

export function formatDateInput(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function formatCustomRange(from: string, to: string): string {
  const start = parseDateBound(from);
  const end = parseDateBound(to);
  if (!start || !end) return 'Select date range';
  const format = (date: Date) => date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  return `${format(start)} – ${format(end)}`;
}

export function getFilterLabel(type: FilterType, value: string, customFrom: string, customTo: string): string {
  if (type === 'ytd') return 'Year to Date';
  if (type === 'custom') return customFrom && customTo ? formatCustomRange(customFrom, customTo) : 'Custom Range';
  if (type === 'month') return getRecentMonths().find(month => month.value === value)?.label ?? value;
  return value;
}
