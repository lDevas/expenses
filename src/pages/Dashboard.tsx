import { useState, useEffect, useMemo } from 'react';
import type { ConsolidatedExchange, Transaction } from '../types/models';
import { apiFetch } from '../lib/api';
import { aggregateCategories, fxFromExchange, type FxInfo } from '../lib/finance';
import EmptyState from '../components/EmptyState';
import NetBalanceCard from '../components/NetBalanceCard';
import CategoryBreakdown from '../components/CategoryBreakdown';

type FilterType = 'month' | 'quarter' | 'year' | 'ytd' | 'custom';
type DateRange = { from?: string; to?: string };

function getMonthsLast12(): { value: string; label: string }[] {
  const months = [];
  const now = new Date();
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const label = d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    months.push({ value, label });
  }
  return months;
}

function getQuartersLast4(): { value: string; label: string }[] {
  const quarters = [];
  const now = new Date();
  const currentQuarter = Math.floor(now.getMonth() / 3);
  for (let i = 3; i >= 0; i--) {
    const yearOffset = Math.floor((currentQuarter - i) / 4);
    const quarter = (currentQuarter - i) % 4;
    const year = now.getFullYear() + yearOffset;
    const adjustedQuarter = quarter < 0 ? quarter + 4 : quarter;
    const adjustedYear = quarter < 0 ? year + 1 : year;
    const value = `${adjustedYear}-Q${adjustedQuarter + 1}`;
    const label = `Q${adjustedQuarter + 1} ${adjustedYear}`;
    quarters.push({ value, label });
  }
  return quarters;
}

function getYearsLast5(): { value: string; label: string }[] {
  const years = [];
  const now = new Date();
  for (let i = 4; i >= 0; i--) {
    const year = now.getFullYear() - i;
    years.push({ value: String(year), label: String(year) });
  }
  return years;
}

function getDateRangeForFilter(filterType: FilterType, filterValue: string, customFrom?: string, customTo?: string): DateRange {
  const now = new Date();

  if (!filterValue) {
    return {};
  }

  switch (filterType) {
    case 'month': {
      const [year, month] = filterValue.split('-');
      const yearNum = Number(year);
      const monthNum = Number(month);
      if (!yearNum || !monthNum || isNaN(yearNum) || isNaN(monthNum)) return {};
      const from = new Date(yearNum, monthNum - 1, 1);
      const to = new Date(yearNum, monthNum, 0);
      to.setHours(23, 59, 59, 999);
      if (isNaN(from.getTime()) || isNaN(to.getTime())) return {};
      return { from: from.toISOString(), to: to.toISOString() };
    }
    case 'quarter': {
      const [year, q] = filterValue.split('-Q');
      const yearNum = Number(year);
      const quarterNum = Number(q);
      if (!yearNum || isNaN(quarterNum) || quarterNum < 1 || quarterNum > 4) return {};
      const quarter = quarterNum - 1;
      const from = new Date(yearNum, quarter * 3, 1);
      const to = new Date(yearNum, (quarter + 1) * 3, 0);
      to.setHours(23, 59, 59, 999);
      if (isNaN(from.getTime()) || isNaN(to.getTime())) return {};
      return { from: from.toISOString(), to: to.toISOString() };
    }
    case 'year': {
      const yearNum = Number(filterValue);
      if (!yearNum || isNaN(yearNum)) return {};
      const from = new Date(yearNum, 0, 1);
      const to = new Date(yearNum, 11, 31);
      to.setHours(23, 59, 59, 999);
      if (isNaN(from.getTime()) || isNaN(to.getTime())) return {};
      return { from: from.toISOString(), to: to.toISOString() };
    }
    case 'ytd': {
      const from = new Date(now.getFullYear(), 0, 1);
      const to = new Date(now.getFullYear(), now.getMonth() + 1, 0);
      to.setHours(23, 59, 59, 999);
      return { from: from.toISOString(), to: to.toISOString() };
    }
    case 'custom':
      return { from: customFrom, to: customTo };
    default:
      return {};
  }
}

export default function Dashboard() {
  const getDefaultFilterValue = (type: FilterType): string => {
    const now = new Date();
    if (type === 'ytd') return 'ytd';
    if (type === 'month') {
      return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    }
    if (type === 'quarter') {
      const currentQuarter = Math.floor(now.getMonth() / 3) + 1;
      return `${now.getFullYear()}-Q${currentQuarter}`;
    }
    if (type === 'year') {
      return String(now.getFullYear());
    }
    return '';
  };

  const [filterType, setFilterType] = useState<FilterType>('ytd');
  const [filterValue, setFilterValue] = useState<string>(() => getDefaultFilterValue('ytd'));
  const [customFrom, setCustomFrom] = useState<string>('');
  const [customTo, setCustomTo] = useState<string>('');
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [fx, setFx] = useState<FxInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const months = useMemo(() => getMonthsLast12(), []);
  const quarters = useMemo(() => getQuartersLast4(), []);
  const years = useMemo(() => getYearsLast5(), []);

  const dateRange = useMemo(() => {
    if (!filterValue) return null;
    const range = getDateRangeForFilter(filterType, filterValue, customFrom, customTo);
    return range.from && range.to ? range : null;
  }, [filterType, filterValue, customFrom, customTo]);

  // Latest FX exchange on any account — used to normalize UYU/USD (not period-bound).
  useEffect(() => {
    let cancelled = false;
    apiFetch<ConsolidatedExchange | null>('/fx/latest')
      .then((data) => {
        if (!cancelled) setFx(fxFromExchange(data));
      })
      .catch(() => {
        if (!cancelled) setFx(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!dateRange) {
      setLoading(false);
      setTransactions([]);
      return;
    }

    let cancelled = false;

    setLoading(true);
    setError(null);

    const params = new URLSearchParams();
    params.set('from', dateRange.from!);
    params.set('to', dateRange.to!);

    apiFetch<Transaction[]>(`/transactions?${params}`)
      .then((data) => {
        if (!cancelled) {
          setTransactions(data);
          setLoading(false);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Failed to load transactions');
          setTransactions([]);
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [dateRange]);

  const { expenseSlices, incomeSlices } = useMemo(() => {
    const expenses = transactions.filter((t) => t.amount < 0);
    const income = transactions.filter((t) => t.amount > 0);
    return {
      expenseSlices: aggregateCategories(expenses, fx),
      incomeSlices: aggregateCategories(income, fx),
    };
  }, [transactions, fx]);

  const getFilterLabel = () => {
    switch (filterType) {
      case 'ytd':
        return 'Year to Date';
      case 'custom':
        return customFrom && customTo ? `${customFrom} to ${customTo}` : 'Custom';
      default:
        const options = filterType === 'month' ? months : filterType === 'quarter' ? quarters : years;
        const option = options.find((o) => o.value === filterValue);
        return option?.label || filterValue;
    }
  };

  return (
    <div>
      <h1>Dashboard</h1>
      <p>Overview of your finances.</p>

      <div className="filter-bar">
        <div className="filter-group">
          <label>Period</label>
          <select
            value={filterType}
            onChange={e => setFilterType(e.target.value as FilterType)}
          >
            <option value="ytd">Year to Date</option>
            <option value="month">Month</option>
            <option value="quarter">Quarter</option>
            <option value="year">Year</option>
            <option value="custom">Custom Range</option>
          </select>
        </div>

        {filterType === 'month' && (
          <div className="filter-group">
            <label>Select Month</label>
            <select value={filterValue} onChange={e => setFilterValue(e.target.value)}>
              {months.map(m => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
          </div>
        )}

        {filterType === 'quarter' && (
          <div className="filter-group">
            <label>Select Quarter</label>
            <select value={filterValue} onChange={e => setFilterValue(e.target.value)}>
              {quarters.map(q => (
                <option key={q.value} value={q.value}>{q.label}</option>
              ))}
            </select>
          </div>
        )}

        {filterType === 'year' && (
          <div className="filter-group">
            <label>Select Year</label>
            <select value={filterValue} onChange={e => setFilterValue(e.target.value)}>
              {years.map(y => (
                <option key={y.value} value={y.value}>{y.label}</option>
              ))}
            </select>
          </div>
        )}

        {filterType === 'custom' && (
          <>
            <div className="filter-group">
              <label>From</label>
              <input type="date" value={customFrom} onChange={e => setCustomFrom(e.target.value)} />
            </div>
            <div className="filter-group">
              <label>To</label>
              <input type="date" value={customTo} onChange={e => setCustomTo(e.target.value)} />
            </div>
          </>
        )}

        <div className="filter-summary">
          <span className="muted">Showing: {getFilterLabel()}</span>
        </div>
      </div>

      {error && <p className="error">{error}</p>}

      {loading ? (
        <p className="muted">Loading transactions...</p>
      ) : transactions.length === 0 ? (
        !error && (
          <EmptyState
            title="No transactions in this period"
            description="Try a different period above, or upload your bank and broker statements to start tracking expenses, income, and net balance."
          />
        )
      ) : (
        <>
          <NetBalanceCard transactions={transactions} fx={fx} />
          <div className="chart-grid">
            <CategoryBreakdown title="Expenses" tone="expense" slices={expenseSlices} fx={fx} />
            <CategoryBreakdown title="Income & Active" tone="income" slices={incomeSlices} fx={fx} />
          </div>
        </>
      )}
    </div>
  );
}
