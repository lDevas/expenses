import { useState, useEffect, useMemo, useRef } from 'react';
import type { Account, ConsolidatedExchange, NetWorthReport, Transaction } from '../types/models';
import { apiFetch } from '../lib/api';
import { convertToUsd, convertToUyu, formatMoney, fxFromExchange, sumByCurrency, matchesCurrencyFilter, type CurrencyFilterValue, type FxInfo } from '../lib/finance';
import AccountFilter from '../components/AccountFilter';
import NetWorthCard from '../components/NetWorthCard';
import PeriodFilter from '../components/PeriodFilter';
import CurrencyFilter from '../components/CurrencyFilter';
import CategoryFilter from '../components/CategoryFilter';
import TransactionCategoryEditor from '../components/TransactionCategoryEditor';
import TransactionDeleteDialog from '../components/TransactionDeleteDialog';
import { matchesCategoryFilters, transactionDirection, type DirectionFilter } from '../lib/categories';
import { useCategories } from '../lib/useCategories';

import { getDateRangeForFilter, getDefaultFilterValue, getFilterLabel, type FilterType } from '../lib/dates';

const PAGE_SIZE = 100;

export default function Details() {
  const [filterType, setFilterType] = useState<FilterType>('ytd');
  const [filterValue, setFilterValue] = useState<string>(() => getDefaultFilterValue('ytd'));
  const [customFrom, setCustomFrom] = useState<string>('');
  const [customTo, setCustomTo] = useState<string>('');
  const [accountId, setAccountId] = useState('');
  const [currency, setCurrency] = useState<CurrencyFilterValue>('');
  const [direction, setDirection] = useState<DirectionFilter>('');
  const [categoryId, setCategoryId] = useState('');
  const [revision, setRevision] = useState(0);
  const [editingTransaction, setEditingTransaction] = useState<Transaction | null>(null);
  const [deletingTransaction, setDeletingTransaction] = useState<Transaction | null>(null);
  const [deleteMessage, setDeleteMessage] = useState('');
  const { categories, categoryError } = useCategories(revision);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fx, setFx] = useState<FxInfo | null>(null);
  const [fxLoading, setFxLoading] = useState(true);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [netWorth, setNetWorth] = useState<NetWorthReport | null>(null);
  const [netWorthLoading, setNetWorthLoading] = useState(false);
  const [netWorthError, setNetWorthError] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const filteredTransactions = useMemo(() => transactions.filter(t => matchesCurrencyFilter(t.currency, currency) && matchesCategoryFilters(t, direction, categoryId)), [transactions, currency, direction, categoryId]);
  const totals = useMemo(() => sumByCurrency(filteredTransactions), [filteredTransactions]);
  const summaryCurrencies = currency === 'UYU' ? ['UYU'] : [
    ...(currency ? [] : ['UYU']), 'USD', ...Object.keys(totals).filter(c => c !== 'UYU' && c !== 'USD').sort(),
  ];
  const hasMore = visibleCount < filteredTransactions.length;
  const net = useMemo(() => ({
    USD: filteredTransactions.reduce((sum, txn) => sum + convertToUsd(txn.amount, txn.currency, fx), 0),
    UYU: filteredTransactions.reduce((sum, txn) => sum + convertToUyu(txn.amount, txn.currency, fx), 0),
  }), [filteredTransactions, fx]);
  const netCurrencies: ('USD' | 'UYU')[] = currency ? [currency] : ['USD', 'UYU'];
  const unsupportedCurrencies = Object.keys(totals).filter(c => c !== 'USD' && c !== 'UYU');

  const dateRange = useMemo(() => {
    if (!filterValue) return null;
    const range = getDateRangeForFilter(filterType, filterValue, customFrom, customTo);
    return range.from && range.to ? range : null;
  }, [filterType, filterValue, customFrom, customTo]);

  // Match the Dashboard's global latest exchange, independent of the filters.
  useEffect(() => {
    let cancelled = false;
    apiFetch<ConsolidatedExchange | null>('/fx/latest')
      .then(data => { if (!cancelled) setFx(fxFromExchange(data)); })
      .catch(() => { if (!cancelled) setFx(null); })
      .finally(() => { if (!cancelled) setFxLoading(false); });
    return () => { cancelled = true; };
  }, []);

  // Account list: the net worth card needs the selected account's type.
  useEffect(() => {
    let cancelled = false;
    apiFetch<Account[]>('/accounts')
      .then(data => { if (!cancelled) setAccounts(data); })
      .catch(() => { if (!cancelled) setAccounts([]); });
    return () => { cancelled = true; };
  }, []);

  const selectedAccount = useMemo(() => accounts.find(a => a.id === accountId) ?? null, [accounts, accountId]);

  // Net worth at the period end, independent of the direction / category filters.
  useEffect(() => {
    if (!dateRange) {
      setNetWorth(null);
      return;
    }

    let cancelled = false;

    setNetWorthLoading(true);
    setNetWorthError(null);

    const params = new URLSearchParams();
    params.set('from', dateRange.from!);
    params.set('to', dateRange.to!);
    if (accountId) params.set('account', accountId);

    apiFetch<NetWorthReport>(`/net-worth?${params}`)
      .then(data => {
        if (!cancelled) {
          setNetWorth(data);
          setNetWorthLoading(false);
        }
      })
      .catch(e => {
        if (!cancelled) {
          setNetWorthError(e instanceof Error ? e.message : 'Failed to load net worth');
          setNetWorth(null);
          setNetWorthLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [dateRange, accountId]);

  useEffect(() => {
    setTransactions([]);
    setVisibleCount(PAGE_SIZE);
    setError(null);
    if (!dateRange) {
      setLoading(false);
      return;
    }
    
    let cancelled = false;
    
    setLoading(true);
    
    const params = new URLSearchParams();
    params.set('from', dateRange.from!);
    params.set('to', dateRange.to!);
    if (accountId) params.set('account', accountId);
    
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
  }, [dateRange, accountId, revision]);

  useEffect(() => {
    const sentinel = loadMoreRef.current;
    if (loading || !hasMore || !sentinel) return;

    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) {
        setVisibleCount(count => Math.min(count + PAGE_SIZE, filteredTransactions.length));
      }
    }, { rootMargin: '300px' });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [loading, hasMore, visibleCount, filteredTransactions.length]);

  return (
    <div className="details-page">
      <h1>Details</h1>
      <p>Transaction and account details.</p>

      <div className="filter-bar">
        <PeriodFilter
          type={filterType}
          value={filterValue}
          customFrom={customFrom}
          customTo={customTo}
          onChange={(type, value) => {
            setFilterType(type);
            setFilterValue(value);
          }}
          onCustomChange={(from, to) => {
            setCustomFrom(from);
            setCustomTo(to);
          }}
        />

        <AccountFilter value={accountId} onChange={setAccountId} />
        <CurrencyFilter value={currency} onChange={value => {
          setCurrency(value);
          setVisibleCount(PAGE_SIZE);
        }} />
        <CategoryFilter direction={direction} categoryId={categoryId} categories={categories}
          onDirectionChange={value => { setDirection(value); setCategoryId(''); setVisibleCount(PAGE_SIZE); }}
          onCategoryChange={value => { setCategoryId(value); setVisibleCount(PAGE_SIZE); }} />

        <div className="filter-summary">
          <span className="muted">Showing: {getFilterLabel(filterType, filterValue, customFrom, customTo)}</span>
        </div>
      </div>

      {error && <p className="error">{error}</p>}
      {categoryError && <p className="error" role="alert">{categoryError}</p>}
      {deleteMessage && <p role="status">{deleteMessage}</p>}
      {netWorthError && <p className="error">{netWorthError}</p>}

      {dateRange && !error && (
        <NetWorthCard
          kind="bank"
          title="Net Worth"
          report={netWorth}
          to={dateRange.to!}
          selected={selectedAccount}
          currency={currency}
          fx={fx}
          loading={netWorthLoading || fxLoading}
        />
      )}

      {dateRange && !error && (
        <section className="balance-card details-summary" aria-labelledby="details-summary-heading" aria-busy={loading || fxLoading}>
          <h2 id="details-summary-heading">Period summary</h2>
          <p className="muted">{getFilterLabel(filterType, filterValue, customFrom, customTo)} · Net total for the selected filters</p>
          <div className="balance-values details-summary-values">
            <div className="details-totals">
              {summaryCurrencies.map(currency => {
                const total = totals[currency] ?? 0;
                return (
                  <div key={currency}>
                    <div className="balance-label">Total ({currency})</div>
                    <span className={`balance-value ${loading ? '' : total < 0 ? 'negative' : total > 0 ? 'positive' : ''}`}>
                      {loading ? '…' : formatMoney(total, currency)}
                    </span>
                  </div>
                );
              })}
            </div>
            <div className="details-net">
              <div className="details-net-values">
                {netCurrencies.map(currency => {
                  const total = net[currency];
                  const ready = !loading && !fxLoading && Number.isFinite(total);
                  return (
                    <div key={currency}>
                      <div className="balance-label">Net ({currency})</div>
                      <span className={`balance-value ${ready && total < 0 ? 'negative' : ready && total > 0 ? 'positive' : ''}`}>
                        {loading || fxLoading ? '…' : ready ? formatMoney(total, currency) : '—'}
                      </span>
                    </div>
                  );
                })}
              </div>
              <p className="details-net-note">
                {fxLoading ? 'Loading exchange rate…' : unsupportedCurrencies.length > 0
                  ? `No exchange rate available for ${unsupportedCurrencies.join(', ')}.`
                  : fx ? `Latest exchange · ${fx.uyuPerUsd.toFixed(2)} UYU per USD${fx.date ? ` · ${new Date(fx.date).toLocaleDateString()}` : ''}`
                  : 'Exchange rate unavailable; totals remain in their original currencies.'}
              </p>
            </div>
          </div>
          <p className="balance-note">{loading ? 'Loading totals…' : `${filteredTransactions.length} transaction${filteredTransactions.length === 1 ? '' : 's'} · Totals include all matching transactions, with currencies kept separate.`}</p>
        </section>
      )}

      <section>
        <h2>All Transactions <span className="muted">({filteredTransactions.length})</span></h2>
        {loading ? (
          <p className="muted">Loading transactions...</p>
        ) : filteredTransactions.length === 0 ? (
          <p className="muted">{direction || categoryId ? 'No transactions match the selected filters.' : 'No transactions in this period.'}</p>
        ) : (
          <>
          <div className="table-wrap">
            <table className="details-table">
              <thead>
                <tr><th>Date</th><th>Description</th><th>Category</th><th className="num">Amount</th><th>Actions</th></tr>
              </thead>
              <tbody>
                {filteredTransactions.slice(0, visibleCount).map(txn => (
                  <tr key={txn.id}>
                    <td>{new Date(txn.date).toLocaleDateString()}</td>
                    <td className="details-description">{txn.description}</td>
                    <td>{transactionDirection(txn) ? <button className="category-cell" aria-label={`Categorize ${txn.description}`} onClick={() => setEditingTransaction(txn)}>
                      {txn.categoryName || 'Uncategorized'}{txn.categorySource === 'manual' && <small>Manual</small>}
                    </button> : <span className="muted">—</span>}</td>
                    <td className={`num ${txn.amount < 0 ? 'neg' : 'pos'}`}>{txn.amount < 0 ? '-' : '+'}{formatMoney(Math.abs(txn.amount), txn.currency)}</td>
                    <td><button className="btn details-delete" aria-label={`Delete ${txn.description}`} onClick={() => { setDeleteMessage(''); setDeletingTransaction(txn); }}>Delete</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="details-scroll-status" ref={loadMoreRef} role="status">
            <p className="muted">Showing {Math.min(visibleCount, filteredTransactions.length)} of {filteredTransactions.length} transactions{hasMore ? ' · Scroll for more' : ' · All transactions shown'}</p>
            {hasMore && <button className="btn" onClick={() => setVisibleCount(count => Math.min(count + PAGE_SIZE, filteredTransactions.length))}>Load more</button>}
          </div>
          </>
        )}
      </section>
      {editingTransaction && <TransactionCategoryEditor transaction={editingTransaction} categories={categories}
        onClose={() => setEditingTransaction(null)} onSaved={() => { setEditingTransaction(null); setRevision(value => value + 1); }} />}
      {deletingTransaction && <TransactionDeleteDialog transaction={deletingTransaction}
        onClose={() => setDeletingTransaction(null)} onDeleted={() => {
          setTransactions(current => current.filter(txn => txn.id !== deletingTransaction.id));
          setDeleteMessage(`Deleted “${deletingTransaction.description}”. Totals updated.`);
          setDeletingTransaction(null);
        }} />}
    </div>
  );
}
