import { useCallback, useEffect, useMemo, useState } from 'react';
import type { InvestmentReport } from '../types/models';
import { apiFetch } from '../lib/api';
import { completeSum, dividendSymbol, getInvestmentView, groupPositions } from '../lib/investments';
import { getDateRangeForFilter, getDefaultFilterValue, getFilterLabel, type FilterType } from '../lib/dates';
import AccountFilter from '../components/AccountFilter';
import PeriodFilter from '../components/PeriodFilter';
import EmptyState from '../components/EmptyState';
import InvestmentCashSummary from '../components/InvestmentCashSummary';
import './Investments.css';

function money(value: number | undefined, currency = 'USD'): string {
  return value === undefined ? '—' : new Intl.NumberFormat('en-US', {
    style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 2,
  }).format(value);
}

function quantity(value: number | undefined): string {
  return value === undefined ? '—' : value.toLocaleString('en-US', { maximumFractionDigits: 6 });
}

function dateLabel(date: string | number): string {
  return new Date(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

const tone = (value: number | undefined) => value === undefined || value === 0 ? '' : value < 0 ? 'neg' : 'pos';

export default function Investments() {
  const [report, setReport] = useState<InvestmentReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filterType, setFilterType] = useState<FilterType>('ytd');
  const [filterValue, setFilterValue] = useState(() => getDefaultFilterValue('ytd'));
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [accountId, setAccountId] = useState('');
  const load = useCallback(() => {
    const controller = new AbortController();
    apiFetch<InvestmentReport>('/investments', { signal: controller.signal })
      .then(data => { if (!controller.signal.aborted) setReport(data); })
      .catch((e: Error) => { if (!controller.signal.aborted) setError(e.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, []);
  useEffect(load, [load]);
  const range = useMemo(() => getDateRangeForFilter(filterType, filterValue, customFrom, customTo),
    [filterType, filterValue, customFrom, customTo]);
  const view = useMemo(() => report?.result ? getInvestmentView(report.result, report.accounts, range, accountId) : null,
    [report, range, accountId]);
  const periodLabel = getFilterLabel(filterType, filterValue, customFrom, customTo);
  const hasData = report?.result && (report.result.positions.length || report.result.items.length ||
    report.result.realized.length || report.result.transfers.length);

  return (
    <div className="investments-page">
      <header className="investments-header">
        <div><h1>Investments</h1><p>Your portfolio, funding, and income across investment accounts.</p></div>
        <span className="badge">Portfolio amounts in USD</span>
      </header>
      {!loading && !error && report && <InvestmentCashSummary cash={report.cash} accountId={accountId} />}
      {loading ? <p role="status">Loading investments…</p> : error ? (
        <div role="alert"><p className="error">{error}</p><button className="btn" onClick={() => { setLoading(true); setError(null); load(); }}>Retry</button></div>
      ) : !hasData ? (
        <EmptyState title="No investments yet" description="Upload broker statements to see positions, account funding, and dividend income."
          icon="📈" actionLabel="Upload Statements" actionTo="/ingest" />
      ) : (
        <>
          <div className="filter-bar">
            <PeriodFilter type={filterType} value={filterValue} customFrom={customFrom} customTo={customTo}
              onChange={(type, value) => { setFilterType(type); setFilterValue(value); }}
              onCustomChange={(from, to) => { setCustomFrom(from); setCustomTo(to); }} />
            <AccountFilter value={accountId} onChange={setAccountId} accounts={report!.accounts}
              allLabel="All investment accounts" showCurrency={false} />
            <div className="filter-summary">{periodLabel}</div>
          </div>
          {!range.from || !range.to ? <p role="status" className="muted">Select a complete date range to view investments.</p> : view && (
            <>
              <div className="stat-grid investments-summary" aria-label="Investment summary">
                <div className="stat-card"><label>Portfolio value</label><span>{money(completeSum(view.positions.map(p => p.value)))}</span><small>{view.positions.length} positions · latest snapshots</small></div>
                <div className="stat-card"><label>Unrealized P/L</label><span className={tone(completeSum(view.positions.map(p => p.unrealizedPl)))}>{money(completeSum(view.positions.map(p => p.unrealizedPl)))}</span><small>Open positions</small></div>
                <div className="stat-card"><label>Realized P/L</label><span className={tone(view.realized.reduce((sum, r) => sum + r.realizedPl, 0))}>{money(view.realized.reduce((sum, r) => sum + r.realizedPl, 0))}</span><small>Selected period</small></div>
                <div className="stat-card"><label>Dividend income</label><span>{money(view.dividends.reduce((sum, d) => sum + d.amount, 0))}</span><small>Net of withholding · selected period</small></div>
              </div>

              <section aria-labelledby="positions-heading">
                <h2 id="positions-heading">Positions <span className="muted">({view.positions.length})</span></h2>
                <p className="investment-section-note">Latest available snapshot per account on or before period end. Matching tickers are combined; average purchase price is weighted by quantity.</p>
                {view.latestSnapshots.size > 0 && <p className="investment-snapshot-note">{[...view.latestSnapshots].map(([id, date]) => {
                  const account = report!.accounts.find(a => a.id === id)!;
                  return `${account.name}${account.accountNumber ? ` · ${account.accountNumber}` : ''}: ${dateLabel(date)}`;
                }).join(' · ')}</p>}
                <div className="table-wrap"><table className="investment-table positions-table" aria-labelledby="positions-heading">
                  <thead><tr><th scope="col">Position</th><th scope="col" className="num">Quantity</th><th scope="col" className="num">Avg. purchase</th><th scope="col" className="num">Cost basis</th><th scope="col" className="num">Market value</th><th scope="col" className="num">Unrealized P/L</th><th scope="col" className="num">Return</th></tr></thead>
                  <tbody>{view.positions.length === 0 ? <tr><td colSpan={7} className="investment-empty">No position snapshots available by this period’s end.</td></tr> : view.positions.map(p => (
                    <tr key={p.key}>
                      <td><strong className="investment-symbol">{p.symbol}</strong>{p.short && <span className="badge">Short</span>}
                        <details className="position-accounts"><summary>{new Set(p.lots.map(l => l.accountId)).size} account{new Set(p.lots.map(l => l.accountId)).size === 1 ? '' : 's'}</summary>
                          {[...new Set(p.lots.map(l => l.accountId))].map(id => {
                            const lots = p.lots.filter(l => l.accountId === id);
                            const holding = groupPositions(lots)[0];
                            return <div key={id}><strong>{lots[0].accountLabel}</strong><span>{quantity(holding.qty)} shares · avg. {money(holding.averageCost, p.currency)}</span><span>Cost {money(holding.costBasis, p.currency)} · value {money(holding.value, p.currency)}</span><span>As of {dateLabel(lots[0].snapshotDate)}</span></div>;
                          })}
                        </details>
                      </td>
                      <td className="num">{quantity(p.qty)}</td><td className="num">{money(p.averageCost, p.currency)}</td>
                      <td className="num">{money(p.costBasis, p.currency)}</td><td className="num">{money(p.value, p.currency)}</td>
                      <td className={`num ${tone(p.unrealizedPl)}`}>{money(p.unrealizedPl, p.currency)}</td>
                      <td className={`num ${tone(p.returnPct)}`}>{p.returnPct === undefined ? '—' : `${p.returnPct.toFixed(2)}%`}</td>
                    </tr>
                  ))}</tbody>
                </table></div>
              </section>

              <section aria-labelledby="funding-heading">
                <div className="investment-section-heading"><h2 id="funding-heading">Account funding <span className="muted">({view.funding.length})</span></h2><span>Net funding: <strong>{money(view.funding.reduce((sum, f) => sum + f.fundingDelta, 0))}</strong></span></div>
                <p className="investment-section-note">Wires recorded by your investment accounts during the selected period. Amounts are the USD amounts received or sent by the broker.</p>
                <div className="table-wrap"><table className="investment-table" aria-labelledby="funding-heading">
                  <thead><tr><th scope="col">Date</th><th scope="col">Investment account</th><th scope="col">Movement</th><th scope="col">Counterparty</th><th scope="col" className="num">Amount</th></tr></thead>
                  <tbody>{view.funding.length === 0 ? <tr><td colSpan={5} className="investment-empty">No account funding in this period.</td></tr> : view.funding.map(f => (
                    <tr key={f.transfer.id}><td>{dateLabel(f.date)}</td><td>{f.accountLabel}</td><td>{f.direction}</td>
                      <td className="investment-description">{f.counterparty}{f.transfer.matchStatus === 'unmatched' && <small>Broker record only</small>}</td>
                      <td className={`num ${f.direction === 'Withdrawal' ? 'neg' : ''}`}>{money(f.amount === undefined ? undefined : f.amount * (f.direction === 'Withdrawal' ? -1 : 1), f.currency)}</td></tr>
                  ))}</tbody>
                </table></div>
              </section>

              <section aria-labelledby="dividends-heading">
                <div className="investment-section-heading"><h2 id="dividends-heading">Dividend income <span className="muted">({view.dividends.length})</span></h2><span>Net received: <strong>{money(view.dividends.reduce((sum, d) => sum + d.amount, 0))}</strong></span></div>
                <div className="table-wrap"><table className="investment-table" aria-labelledby="dividends-heading">
                  <thead><tr><th scope="col">Date</th><th scope="col">Position</th><th scope="col">Account</th><th scope="col" className="num">Gross dividend</th><th scope="col" className="num">Withholding</th><th scope="col" className="num">Net income</th></tr></thead>
                  <tbody>{view.dividends.length === 0 ? <tr><td colSpan={6} className="investment-empty">No dividends in this period.</td></tr> : view.dividends.map(d => (
                    <tr key={d.id}><td>{dateLabel(d.date)}</td><td><strong>{dividendSymbol(d)}</strong></td><td>{d.accountLabel}</td>
                      <td className="num">{money(d.metadata?.gross, d.currency)}</td><td className="num">{money(d.metadata?.withholdingTax, d.currency)}</td><td className={`num ${tone(d.amount)}`}>{money(d.amount, d.currency)}</td></tr>
                  ))}</tbody>
                </table></div>
              </section>

              <section aria-labelledby="realized-heading">
                <h2 id="realized-heading">Realized P/L <span className="muted">({view.realized.length})</span></h2>
                <div className="table-wrap"><table className="investment-table" aria-labelledby="realized-heading">
                  <thead><tr><th scope="col">Date</th><th scope="col">Position</th><th scope="col">Account</th><th scope="col" className="num">Quantity</th><th scope="col" className="num">Proceeds</th><th scope="col" className="num">P/L</th></tr></thead>
                  <tbody>{view.realized.length === 0 ? <tr><td colSpan={6} className="investment-empty">No realized gains or losses in this period.</td></tr> : view.realized.map(r => (
                    <tr key={r.id}><td>{dateLabel(r.date)}</td><td><strong>{r.symbol}</strong></td><td>{r.accountLabel}</td><td className="num">{quantity(r.qty === undefined ? undefined : Math.abs(r.qty))}</td><td className="num">{money(r.proceeds, r.currency)}</td><td className={`num ${tone(r.realizedPl)}`}>{money(r.realizedPl, r.currency)}</td></tr>
                  ))}</tbody>
                </table></div>
              </section>

              <section aria-labelledby="other-income-heading">
                <h2 id="other-income-heading">Interest &amp; charges <span className="muted">({view.otherIncome.length})</span></h2>
                <div className="table-wrap"><table className="investment-table" aria-labelledby="other-income-heading">
                  <thead><tr><th scope="col">Date</th><th scope="col">Account</th><th scope="col">Description</th><th scope="col">Type</th><th scope="col" className="num">Amount</th></tr></thead>
                  <tbody>{view.otherIncome.length === 0 ? <tr><td colSpan={5} className="investment-empty">No interest or charges in this period.</td></tr> : view.otherIncome.map(i => (
                    <tr key={i.id}><td>{dateLabel(i.date)}</td><td>{i.accountLabel}</td><td className="investment-description">{i.description}</td><td>{i.category === 'investment-income' ? 'Interest' : i.category === 'tax' ? 'Tax' : 'Fee'}</td><td className={`num ${tone(i.amount)}`}>{money(i.amount, i.currency)}</td></tr>
                  ))}</tbody>
                </table></div>
              </section>
            </>
          )}
        </>
      )}
    </div>
  );
}
