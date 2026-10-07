import { useMemo } from 'react';
import type { Transaction } from '../types/models';
import { convertToUyu, convertToUsd, formatMoney, type FxInfo } from '../lib/finance';

interface NetBalanceCardProps {
  transactions: Transaction[];
  fx: FxInfo | null;
}

export default function NetBalanceCard({ transactions, fx }: NetBalanceCardProps) {
  const { rawUsd, rawUyu, convertedUsd, convertedUyu, incomeUsd, incomeUyu, expenseUsd, expenseUyu } = useMemo(() => {
    let rawUsd = 0, rawUyu = 0, incomeUsd = 0, incomeUyu = 0, expenseUsd = 0, expenseUyu = 0;
    let convertedUsd = 0, convertedUyu = 0;
    let anyConverted = true;

    for (const t of transactions) {
      const tUsd = convertToUsd(t.amount, t.currency, fx);
      const tUyu = convertToUyu(t.amount, t.currency, fx);
      if (!isNaN(tUsd)) convertedUsd += tUsd; else anyConverted = false;
      if (!isNaN(tUyu)) convertedUyu += tUyu; else anyConverted = false;
      if (t.currency === 'USD') {
        rawUsd += t.amount;
        if (t.amount > 0) incomeUsd += t.amount; else if (t.amount < 0) expenseUsd += t.amount;
      } else if (t.currency === 'UYU') {
        rawUyu += t.amount;
        if (t.amount > 0) incomeUyu += t.amount; else if (t.amount < 0) expenseUyu += t.amount;
      }
    }

    return {
      rawUsd, rawUyu, incomeUsd, incomeUyu, expenseUsd, expenseUyu,
      convertedUsd: anyConverted ? convertedUsd : NaN,
      convertedUyu: anyConverted ? convertedUyu : NaN,
    };
  }, [transactions, fx]);

  const hasUsd = transactions.some((t) => t.currency === 'USD');
  const hasUyu = transactions.some((t) => t.currency === 'UYU');

  const fmt = (v: number, ccy: string) => (v >= 0 ? '' : '−') + formatMoney(Math.abs(v), ccy);
  const cls = (v: number) => (v >= 0 ? 'positive' : 'negative');

  return (
    <section className="balance-card">
      <h2>Net Balance</h2>
      <div className="balance-values">
        {hasUsd && (
          <div>
            <span className={`balance-value ${cls(fx ? convertedUsd : rawUsd)}`}>
              {fmt(fx ? convertedUsd : rawUsd, 'USD')}
            </span>
            <div className="balance-label">Net (USD)</div>
          </div>
        )}
        {hasUyu && (
          <div>
            <span className={`balance-value ${cls(fx ? convertedUyu : rawUyu)}`}>
              {fmt(fx ? convertedUyu : rawUyu, 'UYU')}
            </span>
            <div className="balance-label">Net (UYU)</div>
          </div>
        )}
      </div>

      <div className="balance-sub">
        {hasUsd && (
          <span>
            USD: <span className="pos">{fmt(incomeUsd, 'USD')}</span> in · <span className="neg">{fmt(expenseUsd, 'USD')}</span> out
          </span>
        )}
        {hasUyu && (
          <span>
            UYU: <span className="pos">{fmt(incomeUyu, 'UYU')}</span> in · <span className="neg">{fmt(expenseUyu, 'UYU')}</span> out
          </span>
        )}
      </div>

      {fx ? (
        <p className="balance-note">
          All currencies converted at {fx.uyuPerUsd.toFixed(2)} UYU per 1 USD
          {fx.date ? ` (latest exchange on ${new Date(fx.date).toLocaleDateString()}` : ''}
          {fx.accountLabel ? `, ${fx.accountLabel})` : ')'}
        </p>
      ) : (
        <p className="balance-warn">
          No FX exchange found in your statements — values are per-currency and not directly comparable.
        </p>
      )}
    </section>
  );
}
