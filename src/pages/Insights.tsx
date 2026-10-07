import { useState, useEffect } from 'react';
import type { ConsolidatedPosition, ConsolidatedResult } from '../types/models';
import { apiFetch } from '../lib/api';
import EmptyState from '../components/EmptyState';

function money(n: number | undefined, ccy: string): string {
  if (n === undefined || n === null) return '—';
  return `${n < 0 ? '-' : ''}${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${ccy}`;
}

function dateOf(s: string): string {
  return s.slice(0, 10);
}

export default function Insights() {
  const [result, setResult] = useState<ConsolidatedResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<ConsolidatedResult>('/statements/consolidated')
      .then((data) => setResult(data))
      .catch((e: Error) => setError(e.message));
  }, []);

  if (error) {
    return (
      <div>
        <h1>Insights</h1>
        <p className="error">{error}</p>
      </div>
    );
  }
  if (!result) {
    return (
      <>
        <h1>Insights</h1>
        <p>Investment performance: positions, realized P/L, and income.</p>
        <EmptyState
          title="No insights yet"
          description="Upload broker statements to analyze your investment positions, realized gains/losses, and income."
          icon="📈"
          actionLabel="Upload Statements"
          actionTo="/upload"
        />
      </>
    );
  }

  // Aggregate positions per (account, symbol, snapshotDate)
  const posMap = new Map<string, ConsolidatedPosition[]>();
  for (const p of result.positions) {
    const key = `${p.accountLabel}|${p.symbol}|${dateOf(p.snapshotDate)}`;
    const g = posMap.get(key);
    if (g) g.push(p);
    else posMap.set(key, [p]);
  }
  const posGroups = [...posMap.values()];

  const income = result.items.filter((it) => it.category === 'investment-income' || it.category === 'tax' || it.category === 'fee');
  const divIncome = income.filter((it) => it.category === 'investment-income');

  // Realized P/L
  const realizedNet = result.realized.reduce((s, r) => s + r.realizedPl, 0);

  return (
    <div>
      <h1>Insights</h1>
      <p>Investment performance: positions, realized P/L, and income.</p>

      <div className="stat-grid">
        <div className="stat-card"><span>{result.positions.length}</span><label>positions</label></div>
        <div className="stat-card"><span>{result.realized.length}</span><label>realized</label></div>
        <div className="stat-card"><span>{divIncome.length}</span><label>dividends</label></div>
        <div className="stat-card"><span>{money(realizedNet, 'USD')}</span><label>realized P/L</label></div>
      </div>

      <section>
        <h2>Positions <span className="muted">({posGroups.length})</span></h2>
        {posGroups.map((g, i) => {
          const p = g[0];
          const qty = g.reduce((s, x) => s + x.qty, 0);
          const cost = g.reduce((s, x) => s + (x.costBasis ?? 0), 0);
          const value = g.reduce((s, x) => s + (x.value ?? 0), 0);
          const upl = value - cost;
          return (
            <div key={i} className="pos-row">
              <span className="pos-sym">{p.symbol}</span>
              <span className="ellipsize">{p.accountLabel}</span>
              <span className="num">qty {qty}</span>
              <span className="num">{money(cost, p.currency)}</span>
              <span className="num">{money(value, p.currency)}</span>
              <span className={`num ${upl < 0 ? 'neg' : 'pos'}`}>{money(upl, p.currency)}</span>
            </div>
          );
        })}
      </section>

      <section>
        <h2>Realized P/L <span className="muted">({result.realized.length})</span></h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Date</th><th>Symbol</th><th className="num">Qty</th><th className="num">Proceeds</th><th className="num">P/L</th></tr>
            </thead>
            <tbody>
              {result.realized.map((r) => (
                <tr key={r.id}>
                  <td>{dateOf(r.date)}</td>
                  <td>{r.symbol}{r.name && r.name !== r.symbol ? ` (${r.name})` : ''}</td>
                  <td className="num">{r.qty ?? '—'}</td>
                  <td className="num">{money(r.proceeds, r.currency)}</td>
                  <td className={`num ${r.realizedPl < 0 ? 'neg' : 'pos'}`}>{money(r.realizedPl, r.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2>Investment income <span className="muted">({income.length})</span></h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Date</th><th>Account</th><th>Description</th><th className="num">Amount</th></tr>
            </thead>
            <tbody>
              {income.map((it) => (
                <tr key={it.id}>
                  <td>{dateOf(it.date)}</td>
                  <td className="ellipsize">{it.accountLabel}</td>
                  <td className="ellipsize">{it.description}</td>
                  <td className={`num ${it.amount < 0 ? 'neg' : 'pos'}`}>{money(it.amount, it.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
