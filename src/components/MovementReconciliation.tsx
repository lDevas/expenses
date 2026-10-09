import { useState } from 'react';
import type { ConsolidatedExchange, ConsolidatedTransfer } from '../types/models';
import { formatMoney } from '../lib/finance';

const date = (value?: string) => value ? value.slice(0, 10) : '—';
const money = (amount?: number, currency?: string) => amount === undefined ? 'Statement missing' : formatMoney(amount, currency ?? '');
const wireDifference = (transfer: ConsolidatedTransfer) => transfer.kind === 'wire' && transfer.matchStatus === 'matched' &&
  transfer.fromCurrency && transfer.fromCurrency === transfer.toCurrency &&
  transfer.fromAmount !== undefined && transfer.toAmount !== undefined && transfer.fromAmount - transfer.toAmount > 0.01
  ? Math.round((transfer.fromAmount - transfer.toAmount) * 100) / 100 : undefined;

export default function MovementReconciliation({ transfers, exchanges }: {
  transfers: ConsolidatedTransfer[];
  exchanges: ConsolidatedExchange[];
}) {
  const [status, setStatus] = useState('all');
  const matched = [...transfers, ...exchanges].filter(row => row.matchStatus === 'matched').length;
  const total = transfers.length + exchanges.length;
  const visibleTransfers = transfers.filter(row => status === 'all' || row.matchStatus === status);
  const visibleExchanges = exchanges.filter(row => status === 'all' || row.matchStatus === status);
  const showDifference = transfers.some(transfer => wireDifference(transfer) !== undefined);
  return (
    <section className="movement-reconciliation" aria-labelledby="reconciliation-heading">
      <div className="report-section-heading">
        <h2 id="reconciliation-heading">Transfer reconciliation</h2>
        <span>{matched} matched · {total - matched} unmatched</span>
      </div>
      <p className="coverage-explanation">Transfers between your accounts, card payments, and currency exchanges are not expenses or income. Matched movements have records on both sides. Unmatched movements need a counterpart statement or a clearer account reference.</p>
      {total > 0 ? <>
        <div className="timeline-controls">
          <label htmlFor="movement-status">Status</label>
          <select id="movement-status" value={status} onChange={e => setStatus(e.target.value)}>
            <option value="all">All movements</option><option value="matched">Matched</option><option value="unmatched">Unmatched</option>
          </select>
        </div>
        {visibleTransfers.length > 0 && <div className="table-wrap"><table>
          <caption>Transfers &amp; card payments</caption>
          <thead><tr><th>Type</th><th>Status</th><th>From</th><th>To</th>{showDifference && <th>Difference</th>}<th>Source files</th></tr></thead>
          <tbody>{visibleTransfers.map(t => {
            const fromMissing = t.matchStatus === 'unmatched' && (!t.fromAccountId || t.fromAmount === undefined);
            const toMissing = t.matchStatus === 'unmatched' && (!t.toAccountId || t.toAmount === undefined);
            const difference = wireDifference(t);
            return <tr key={t.id}>
              <td>{t.kind === 'internal' ? 'Own-account transfer' : t.kind === 'card' ? 'Card payment' : 'Broker wire'}</td>
              <td><span className={`badge ${t.matchStatus === 'matched' ? 'ok' : 'warn'}`}>{t.matchStatus}</span></td>
              <td title={t.fromDescription} className={fromMissing ? 'reconciliation-missing-side' : undefined}>
                {t.fromAccountLabel}<br />{fromMissing ? <strong>From side missing</strong> : <>{money(t.fromAmount, t.fromCurrency)}<br /><small>{date(t.fromDate)}</small></>}
              </td>
              <td title={t.toDescription} className={toMissing ? 'reconciliation-missing-side' : undefined}>
                {t.toAccountLabel}<br />{toMissing ? <strong>To side missing</strong> : <>{money(t.toAmount, t.toCurrency)}<br /><small>{date(t.toDate)}</small></>}
              </td>
              {showDifference && <td>{difference === undefined ? '—' : <>{money(difference, t.fromCurrency)}<br /><small>Possible fees</small></>}</td>}
              <td>{t.sourceFiles.join(', ')}</td>
            </tr>;
          })}</tbody>
        </table></div>}
        {visibleExchanges.length > 0 && <div className="table-wrap"><table>
          <caption>Currency exchanges</caption>
          <thead><tr><th>Status</th><th>Date</th><th>Accounts</th><th>Sold</th><th>Bought</th><th className="num">Rate</th><th>Source files</th></tr></thead>
          <tbody>{visibleExchanges.map(e => <tr key={e.id}>
            <td><span className={`badge ${e.matchStatus === 'matched' ? 'ok' : 'warn'}`}>{e.matchStatus}</span></td>
            <td>{date(e.date)}</td><td title={e.description}>{e.accountLabel}</td>
            <td className={e.matchStatus === 'unmatched' && e.fromAmount === undefined ? 'reconciliation-missing-side' : undefined}>
              {e.matchStatus === 'unmatched' && e.fromAmount === undefined ? <strong>Sold side missing</strong> : money(e.fromAmount, e.fromCurrency)}
            </td>
            <td className={e.matchStatus === 'unmatched' && e.toAmount === undefined ? 'reconciliation-missing-side' : undefined}>
              {e.matchStatus === 'unmatched' && e.toAmount === undefined ? <strong>Bought side missing</strong> : money(e.toAmount, e.toCurrency)}
            </td>
            <td className="num">{e.impliedRate === undefined ? '—' : e.impliedRate.toLocaleString(undefined, { maximumFractionDigits: 6 })}</td>
            <td>{e.sourceFiles.join(', ')}</td>
          </tr>)}</tbody>
        </table></div>}
        {!visibleTransfers.length && !visibleExchanges.length && <p className="muted">No {status} movements.</p>}
      </> : <p className="muted">No own-account movements found in your uploaded statements.</p>}
    </section>
  );
}
