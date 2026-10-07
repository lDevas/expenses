import { useState, useEffect, useMemo } from 'react';
import type { Transaction } from '../types/models';
import { apiFetch } from '../lib/api';

import { getDateRangeForFilter, getDefaultFilterValue, getMonthsLast12, getQuartersLast4, getYearsLast5, type FilterType } from '../lib/dates';

export default function Details() {
  const [filterType, setFilterType] = useState<FilterType>('ytd');
  const [filterValue, setFilterValue] = useState<string>(() => getDefaultFilterValue('ytd'));
  const [customFrom, setCustomFrom] = useState<string>('');
  const [customTo, setCustomTo] = useState<string>('');
  const [transactions, setTransactions] = useState<Transaction[]>([]);
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
      .then(data => {
        if (!cancelled) {
          setTransactions(data);
          setLoading(false);
        }
      })
      .catch(e => {
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

  const formatCurrency = (amount: number, currency: string) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
    }).format(Math.abs(amount));
  };

  const getFilterLabel = () => {
    switch (filterType) {
      case 'ytd':
        return 'Year to Date';
      case 'custom':
        return customFrom && customTo ? `${customFrom} to ${customTo}` : 'Custom';
      default:
        const options = filterType === 'month' ? months : filterType === 'quarter' ? quarters : years;
        const option = options.find(o => o.value === filterValue);
        return option?.label || filterValue;
    }
  };

  return (
    <div>
      <h1>Details</h1>
      <p>Transaction and account details.</p>

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

      <section>
        <h2>All Transactions <span className="muted">({transactions.length})</span></h2>
        {loading ? (
          <p className="muted">Loading transactions...</p>
        ) : transactions.length === 0 ? (
          <p className="muted">No transactions in this period.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Date</th><th>Description</th><th>Category</th><th>Source</th><th className="num">Amount</th></tr>
              </thead>
              <tbody>
                {transactions.slice(0, 200).map(txn => (
                  <tr key={txn.id}>
                    <td>{new Date(txn.date).toLocaleDateString()}</td>
                    <td className="ellipsize" title={txn.description}>{txn.description}</td>
                    <td>{txn.category || '—'}</td>
                    <td>{txn.source}</td>
                    <td className={`num ${txn.amount < 0 ? 'neg' : 'pos'}`}>{txn.amount < 0 ? '-' : '+'}{formatCurrency(txn.amount, txn.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
