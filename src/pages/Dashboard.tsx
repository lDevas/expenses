import { useState, useEffect, useMemo } from 'react';
import type { Account, ConsolidatedExchange, NetWorthReport, Transaction } from '../types/models';
import { apiFetch } from '../lib/api';
import { aggregateCategories, fxFromExchange, isFinancialTransaction, matchesCurrencyFilter, type CurrencyFilterValue, type FxInfo } from '../lib/finance';
import { buildCombinedLines, buildLines, linesNote, type NetWorthLine } from '../lib/netWorth';
import EmptyState from '../components/EmptyState';
import NetBalanceCard from '../components/NetBalanceCard';
import NetWorthCard from '../components/NetWorthCard';
import NetWorthChart from '../components/NetWorthChart';
import CategoryBreakdown from '../components/CategoryBreakdown';
import AccountFilter from '../components/AccountFilter';
import PeriodFilter from '../components/PeriodFilter';
import CurrencyFilter from '../components/CurrencyFilter';
import CategoryFilter from '../components/CategoryFilter';
import { matchesCategoryFilters, type DirectionFilter } from '../lib/categories';
import { useCategories } from '../lib/useCategories';

import { getDateRangeForFilter, getDefaultFilterValue, getFilterLabel, type FilterType } from '../lib/dates';

export default function Dashboard() {
  const [filterType, setFilterType] = useState<FilterType>('ytd');
  const [filterValue, setFilterValue] = useState<string>(() => getDefaultFilterValue('ytd'));
  const [customFrom, setCustomFrom] = useState<string>('');
  const [customTo, setCustomTo] = useState<string>('');
  const [accountId, setAccountId] = useState('');
  const [currency, setCurrency] = useState<CurrencyFilterValue>('');
  const [direction, setDirection] = useState<DirectionFilter>('');
  const [categoryId, setCategoryId] = useState('');
  const { categories, categoryError } = useCategories();
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [fx, setFx] = useState<FxInfo | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [netWorth, setNetWorth] = useState<NetWorthReport | null>(null);
  const [netWorthLoading, setNetWorthLoading] = useState(false);
  const [netWorthError, setNetWorthError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  // Account list: the net worth section needs the selected account's type.
  useEffect(() => {
    let cancelled = false;
    apiFetch<Account[]>('/accounts')
      .then((data) => {
        if (!cancelled) setAccounts(data);
      })
      .catch(() => {
        if (!cancelled) setAccounts([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Net worth series: period- and account-bound, independent of the
  // currency / direction / category filters (those apply client-side).
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
      .then((data) => {
        if (!cancelled) {
          setNetWorth(data);
          setNetWorthLoading(false);
        }
      })
      .catch((e) => {
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
    if (accountId) params.set('account', accountId);

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
  }, [dateRange, accountId]);

  const filteredTransactions = useMemo(() => transactions.filter(t => matchesCurrencyFilter(t.currency, currency) && matchesCategoryFilters(t, direction, categoryId)), [transactions, currency, direction, categoryId]);
  const chartKey = JSON.stringify([currency, direction, categoryId, dateRange, accountId]);

  const selectedAccount = useMemo(() => accounts.find(a => a.id === accountId) ?? null, [accounts, accountId]);

  // Net worth charts: bank lines, and bank + investments + combined total.
  const { bankLines, combinedLines } = useMemo(() => {
    if (!netWorth) return { bankLines: [] as NetWorthLine[], combinedLines: [] as NetWorthLine[] };
    const bank = buildLines('Bank', 'bank', netWorth, selectedAccount, currency, fx);
    const investments = buildLines('Investments', 'investment', netWorth, selectedAccount, currency, fx);
    return { bankLines: bank, combinedLines: buildCombinedLines(bank, investments) };
  }, [netWorth, selectedAccount, currency, fx]);

  const { expenseSlices, incomeSlices, investmentSlices } = useMemo(() => {
    const expenses = filteredTransactions.filter((t) => isFinancialTransaction(t) && t.amount < 0);
    const credits = filteredTransactions.filter((t) => isFinancialTransaction(t) && t.amount > 0);
    const income = credits.filter((t) => t.category !== 'investment-income');
    const investments = credits.filter((t) => t.category === 'investment-income');
    return {
      expenseSlices: aggregateCategories(expenses, fx),
      incomeSlices: aggregateCategories(income, fx),
      investmentSlices: aggregateCategories(investments, fx),
    };
  }, [filteredTransactions, fx]);

  return (
    <div className="dashboard-page">
      <h1>Dashboard</h1>
      <p>Overview of your finances.</p>

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
        <CurrencyFilter value={currency} onChange={setCurrency} />
        <CategoryFilter direction={direction} categoryId={categoryId} categories={categories}
          onDirectionChange={value => { setDirection(value); setCategoryId(''); }} onCategoryChange={setCategoryId} />

        <div className="filter-summary">
          <span className="muted">Showing: {getFilterLabel(filterType, filterValue, customFrom, customTo)}</span>
        </div>
      </div>

      {error && <p className="error">{error}</p>}
      {categoryError && <p className="error" role="alert">{categoryError}</p>}
      {netWorthError && <p className="error">{netWorthError}</p>}

      {/* Net worth is statement-derived and shows even in zero-transaction periods,
          so it renders outside the transactions empty-state gate. */}
      {dateRange ? (
        <>
          <NetWorthCard
            kind="bank"
            title="Net Worth"
            report={netWorth}
            to={dateRange.to!}
            selected={selectedAccount}
            currency={currency}
            fx={fx}
            loading={netWorthLoading}
          />
          <div className="chart-grid net-worth-charts">
            <NetWorthChart key={`bank-${chartKey}`} title="Bank net worth" lines={bankLines} note={linesNote(bankLines, fx)} />
            <NetWorthChart key={`combined-${chartKey}`} title="Net worth including investments" lines={combinedLines} note={linesNote(combinedLines, fx)} />
          </div>
        </>
      ) : null}

      {loading ? (
        <p className="muted">Loading transactions...</p>
      ) : filteredTransactions.length === 0 ? (
        !error && (
          <EmptyState
            title="No transactions in this period"
            description="Try a different period, account, currency, type, or category above, or upload your bank and broker statements."
          />
        )
      ) : (
        <>
          <NetBalanceCard transactions={filteredTransactions} fx={fx} />
          <div className="chart-grid">
            {direction !== 'income' && <CategoryBreakdown key={`expenses-${chartKey}`} title="Expenses" tone="expense" slices={expenseSlices} fx={fx} />}
            {direction !== 'expense' && <CategoryBreakdown key={`income-${chartKey}`} title="Income" tone="income" slices={incomeSlices} fx={fx} />}
            {direction !== 'expense' && <CategoryBreakdown key={`investments-${chartKey}`} title="Investments" tone="income" slices={investmentSlices} fx={fx} />}
          </div>
        </>
      )}
    </div>
  );
}
