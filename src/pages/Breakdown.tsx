import { useState, useEffect, useCallback } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { ConsolidatedItem, ConsolidatedResult, ConsolidatedCategory } from '../types/models';
import { ApiError, apiFetch } from '../lib/api';
import EmptyState from '../components/EmptyState';

const CATEGORY_ORDER: ConsolidatedCategory[] = [
  'expense',
  'card-payment',
  'fee',
  'income',
  'investment-income',
  'tax',
  'transfer-in',
  'transfer-out',
  'internal-transfer',
  'other',
];

function money(n: number, ccy: string): string {
  return `${n < 0 ? '-' : ''}${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${ccy}`;
}

function dateOf(s: string): string {
  return s.slice(0, 10);
}

function sumByCurrency(items: ConsolidatedItem[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const it of items) out[it.currency] = (out[it.currency] ?? 0) + it.amount;
  return out;
}

export default function Breakdown() {
  const [result, setResult] = useState<ConsolidatedResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [params] = useSearchParams();
  const runId = params.get('run');
  const load = useCallback(() => {
    setLoading(true);
    apiFetch<ConsolidatedResult>(runId ? `/consolidation/runs/${encodeURIComponent(runId)}` : '/statements/consolidated')
      .then((data) => { setResult(data); setError(null); })
      .catch((e: Error) => {
        setResult(null);
        setError(e instanceof ApiError && e.status === 404 && !runId ? null : e.message);
      })
      .finally(() => setLoading(false));
  }, [runId]);
  useEffect(load, [load]);

  if (error) {
    return (
      <div>
        <h1>Breakdown</h1>
        <p className="error">{error}</p>
        <button className="btn" onClick={load}>Retry</button>
      </div>
    );
  }

  return (
    <div>
      <h1>Breakdown</h1>
      <p>Consolidated bank &amp; broker statements, deduped and categorized. Currencies are kept separate.</p>

      <p className="breakdown-ingestion-link"><Link to="/ingest">Upload statements &amp; view run history →</Link></p>
      {loading && <p role="status">Loading run…</p>}

      {loading ? null : !result ? (
        <EmptyState
          title="No consolidation yet"
          description="Upload bank and broker statements to see a consolidated view of transactions, transfers, exchanges, positions, and realized P/L."
          icon="📊"
          actionLabel="Upload Statements"
          actionTo="/ingest"
        />
      ) : (
        <>
          <div className="stat-grid">
            <div className="stat-card"><span>{result.items.length}</span><label>items</label></div>
            <div className="stat-card"><span>{result.transfers.length}</span><label>transfers</label></div>
            <div className="stat-card"><span>{result.exchanges.length}</span><label>fx exchanges</label></div>
            <div className="stat-card"><span>{result.positions.length}</span><label>positions</label></div>
            <div className="stat-card"><span>{result.realized.length}</span><label>realized</label></div>
            <div className="stat-card"><span>{result.issues.length}</span><label>issues</label></div>
          </div>
          <p className="muted">{runId ? `Run ${result.runId.slice(0, 8)}` : 'All uploaded statements'} — updated {new Date(result.generatedAt).toLocaleString()} — {result.files.length} files</p>

          {result.issues.length > 0 && (
            <section>
              <h2>Issues</h2>
              <ul className="issue-list">
                {result.issues.map((iss, i) => (
                  <li key={i} className={`issue ${iss.severity}`}>
                    <span className="badge">{iss.severity}</span>
                    <span className="issue-where">{[iss.file, iss.sheet, iss.row != null ? `row ${iss.row}` : null, iss.field].filter(Boolean).join(' · ')}</span>
                    <span>{iss.message}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {CATEGORY_ORDER.map((cat) => {
            const rows = result.items.filter((it) => it.category === cat);
            if (rows.length === 0) return null;
            const totals = sumByCurrency(rows);
            return (
              <section key={cat}>
                <h2>
                  {cat} <span className="muted">({rows.length})</span>
                  {Object.entries(totals).map(([ccy, sum]) => (
                    <span key={ccy} className="stat-inline"> {sum >= 0 ? '' : ''}{money(sum, ccy)}</span>
                  ))}
                </h2>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr><th>Date</th><th>Account</th><th>Description</th><th className="num">Amount</th></tr>
                    </thead>
                    <tbody>
                      {rows.map((it) => (
                        <tr key={it.id}>
                          <td>{dateOf(it.date)}</td>
                          <td className="ellipsize" title={it.accountLabel}>{it.accountLabel}</td>
                          <td className="ellipsize" title={it.description}>{it.description}</td>
                          <td className={`num ${it.amount < 0 ? 'neg' : 'pos'}`}>{money(it.amount, it.currency)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            );
          })}

          <section>
            <h2>Transfers <span className="muted">({result.transfers.length})</span></h2>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>Type</th><th>Status</th><th>From</th><th>To</th><th className="num">Rate</th></tr>
                </thead>
                <tbody>
                  {result.transfers.map((t) => (
                    <tr key={t.id}>
                      <td>{t.kind}</td>
                      <td><span className={`badge ${t.matchStatus === 'matched' ? 'ok' : 'warn'}`}>{t.matchStatus}</span></td>
                      <td className="ellipsize">{t.fromAccountLabel}{t.fromAmount !== undefined && ` — ${money(t.fromAmount, t.fromCurrency ?? '')}`}</td>
                      <td className="ellipsize">{t.toAccountLabel}{t.toAmount !== undefined && ` — ${money(t.toAmount, t.toCurrency ?? '')}`}</td>
                      <td className="num">{t.impliedRate ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section>
            <h2>FX exchanges <span className="muted">({result.exchanges.length})</span></h2>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>Status</th><th>Date</th><th>Account</th><th>Legs</th><th className="num">Rate</th></tr>
                </thead>
                <tbody>
                  {result.exchanges.map((e) => (
                    <tr key={e.id}>
                      <td><span className={`badge ${e.matchStatus === 'matched' ? 'ok' : 'warn'}`}>{e.matchStatus}</span></td>
                      <td>{e.date ? dateOf(e.date) : '—'}</td>
                      <td className="ellipsize">{e.accountLabel}</td>
                      <td>{e.fromAmount !== undefined ? `${money(e.fromAmount, e.fromCurrency ?? '')} → ${e.toAmount !== undefined ? money(e.toAmount, e.toCurrency ?? '') : '?'}` : '—'}</td>
                      <td className="num">{e.impliedRate ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
