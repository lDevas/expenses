import { useState, useEffect, useMemo } from 'react';
import type { ConsolidatedExchange, Transaction } from '../types/models';
import { apiFetch } from '../lib/api';
import { aggregateCategories, fxFromExchange, isFinancialTransaction, type FxInfo } from '../lib/finance';
import EmptyState from '../components/EmptyState';
import NetBalanceCard from '../components/NetBalanceCard';
import CategoryBreakdown from '../components/CategoryBreakdown';

import { getDateRangeForFilter, getDefaultFilterValue, getMonthsLast12, getQuartersLast4, getYearsLast5, type FilterType } from '../lib/dates';

export default function Dashboard() {
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
    const expenses = transactions.filter((t) => isFinancialTransaction(t) && t.amount < 0);
    const income = transactions.filter((t) => isFinancialTransaction(t) && t.amount > 0);
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
            onChange={e => {
              const type = e.target.value as FilterType;
              setFilterType(type);
              setFilterValue(getDefaultFilterValue(type));
            }}
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
