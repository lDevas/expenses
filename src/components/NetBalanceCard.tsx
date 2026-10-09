import { useMemo } from 'react';
import type { Transaction } from '../types/models';
import { convertToUyu, convertToUsd, formatMoney, isFinancialTransaction, sumByCurrency, type FxInfo } from '../lib/finance';

interface NetBalanceCardProps {
  transactions: Transaction[];
  fx: FxInfo | null;
}

export default function NetBalanceCard({ transactions, fx }: NetBalanceCardProps) {
  const { totals, income, expenses, convertedUsd, convertedUyu, canConvert } = useMemo(() => {
    const financial = transactions.filter(isFinancialTransaction);
    const totals = sumByCurrency(financial);
    const income = sumByCurrency(financial.filter(t => t.amount > 0));
    const expenses = sumByCurrency(financial.filter(t => t.amount < 0));
    let convertedUsd = 0, convertedUyu = 0;
    let canConvert = true;

    for (const t of financial) {
      const tUsd = convertToUsd(t.amount, t.currency, fx);
      const tUyu = convertToUyu(t.amount, t.currency, fx);
      if (Number.isFinite(tUsd)) convertedUsd += tUsd; else canConvert = false;
      if (Number.isFinite(tUyu)) convertedUyu += tUyu; else canConvert = false;
    }

    return {
      totals, income, expenses, convertedUsd, convertedUyu, canConvert,
    };
  }, [transactions, fx]);

  const currencies = ['USD', 'UYU', ...Object.keys(totals).filter(c => c !== 'USD' && c !== 'UYU').sort()]
    .filter(c => totals[c] !== undefined);
  const unsupportedCurrencies = currencies.filter(c => c !== 'USD' && c !== 'UYU');

  const fmt = (v: number, ccy: string) => (v >= 0 ? '' : '−') + formatMoney(Math.abs(v), ccy);
  const cls = (v: number) => (v >= 0 ? 'positive' : 'negative');

  return (
    <section className="balance-card">
      <h2>Net Balance</h2>
      {currencies.length === 0 && <p>No income or expenses in this period.</p>}
      <div className="balance-values">
        {currencies.map(currency => {
          const total = fx && canConvert ? (currency === 'USD' ? convertedUsd : convertedUyu) : totals[currency];
          return (
            <div key={currency}>
              <span className={`balance-value ${cls(total)}`}>{fmt(total, currency)}</span>
              <div className="balance-label">Net ({currency})</div>
            </div>
          );
        })}
      </div>

      <div className="balance-sub">
        {currencies.map(currency => (
          <span key={currency}>
            {currency}: <span className="pos">{fmt(income[currency] ?? 0, currency)}</span> in · <span className="neg">{fmt(expenses[currency] ?? 0, currency)}</span> out
          </span>
        ))}
      </div>

      {unsupportedCurrencies.length > 0 ? (
        <p className="balance-note">Amounts shown in their original currencies; no exchange rate available for {unsupportedCurrencies.join(', ')}.</p>
      ) : fx ? (
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
