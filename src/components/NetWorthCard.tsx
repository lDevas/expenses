import { useMemo } from 'react';
import type { Account, NetWorthReport } from '../types/models';
import type { CurrencyFilterValue, FxInfo } from '../lib/finance';
import { formatMoney } from '../lib/finance';
import { netWorthCardData, type NetWorthKind } from '../lib/netWorth';

interface NetWorthCardProps {
  kind: NetWorthKind;
  title: string;
  report: NetWorthReport | null;
  /** Period end (ISO). The card shows each account's last value on or before it. */
  to: string;
  selected: Account | null;
  currency: CurrencyFilterValue;
  fx: FxInfo | null;
  /** Suppresses the empty-state text while the report is still loading. */
  loading?: boolean;
}

const currencyOrder = (currencies: string[]) =>
  [...currencies].sort((a, b) => {
    const rank = (c: string) => (c === 'USD' ? 0 : c === 'UYU' ? 1 : 2);
    return rank(a) - rank(b) || a.localeCompare(b);
  });

/**
 * Net worth at the period end, per the selected filters: one value per
 * currency, a USD total when a rate exists, and per-account detail.
 */
export default function NetWorthCard({ kind, title, report, to, selected, currency, fx, loading = false }: NetWorthCardProps) {
  const data = useMemo(
    () => (report ? netWorthCardData(kind, report, to, selected, currency, fx) : null),
    [kind, report, to, selected, currency, fx],
  );

  const currencies = data ? currencyOrder(Object.keys(data.perCurrency)) : [];
  const hasUsdTotal = data !== null && data.usd !== null && data.usd !== undefined;
  const noFx = !fx;
  const unsupported = currencies.filter(c => c !== 'USD' && c !== 'UYU');
  const missing = data ? [
    ...data.accounts.filter(a => a.amount === null).map(a => a.label),
    ...data.unreported.map(a => a.accountLabel),
  ] : [];
  const empty = !data || (currencies.length === 0 && !hasUsdTotal);

  return (
    <section className="net-worth-card" aria-busy={loading}>
      <h2>{title}</h2>

      {loading && <p className="muted">Loading net worth…</p>}
      {empty && !loading && <p>No balance data reported for this period — upload a statement to populate it.</p>}

      <div className="balance-values">
        {hasUsdTotal && data ? (
          <div>
            <span className="balance-value">{formatMoney(data.usd!, 'USD')}</span>
            <div className="balance-label">Total (USD)</div>
          </div>
        ) : null}
        {data ? currencies.filter(c => !(hasUsdTotal && currencies.length === 1 && c === 'USD')).map((ccy) => {
          const v = data.perCurrency[ccy];
          return (
            <div key={ccy}>
              <span className="balance-value">{v.amount !== null ? formatMoney(v.amount, ccy) : '—'}</span>
              <div className="balance-label">{ccy}{v.asOf ? ` · as of ${v.asOf}` : ''}</div>
            </div>
          );
        }) : null}
      </div>

      {data ? (
        <>
          {data.accounts.length > 1 && (
            <details className="account-details">
              <summary>View {data.accounts.length} accounts</summary>
              <ul>
                {data.accounts.map(a => (
                  <li key={a.accountId}>
                    <span className="name">{a.label}</span>
                    <span className="meta">{a.asOf ? `as of ${a.asOf}` : 'no data'}</span>
                    <span className="val">{a.amount !== null ? formatMoney(a.amount, a.currency) : '—'}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}

          {missing.length > 0 && (
            <p className="balance-note">No balance reported for {missing.join(', ')}.</p>
          )}
          {unsupported.length > 0 ? (
            <p className="balance-note">
              Amounts shown in their original currencies; no exchange rate available for {unsupported.join(', ')}.
            </p>
          ) : noFx ? (
            <p className="balance-warn">No FX exchange found in your statements — values are per-currency and not directly comparable.</p>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
