import type { InvestmentCashBalance, InvestmentReport } from '../types/models';
import { formatMoney } from '../lib/finance';

function CashCard({ title, description, balances }: {
  title: string;
  description: string;
  balances: InvestmentCashBalance[];
}) {
  const currencies = [...new Set(balances.map(b => b.currency))].sort((a, b) => a === 'USD' ? -1 : b === 'USD' ? 1 : a.localeCompare(b));
  const missing = balances.filter(b => b.available === null).length;
  return (
    <article className="investment-cash-card">
      <h2>{title}</h2>
      <p className="investment-section-note">{description}</p>
      <div className="investment-cash-totals">
        {currencies.map(currency => {
          const rows = balances.filter(b => b.currency === currency);
          const known = rows.filter(b => b.available !== null);
          const incomplete = known.length !== rows.length;
          return <div key={currency}>
            <span className="investment-cash-label">{currency}{incomplete && known.length > 0 ? ' · reported subtotal' : ''}</span>
            <strong className="investment-cash-total">{known.length ? formatMoney(known.reduce((sum, b) => sum + b.available!, 0), currency) : '—'}</strong>
          </div>;
        })}
        {balances.length === 0 && <p className="muted">No accounts to show.</p>}
      </div>
      {missing > 0 && <p className="investment-cash-missing">Cash not reported for {missing} account{missing === 1 ? '' : 's'}.</p>}
      {balances.length > 0 && <details className="investment-cash-details">
        <summary>View {balances.length} account{balances.length === 1 ? '' : 's'}</summary>
        <ul>{balances.map(b => <li key={b.accountId}>
          <div><strong>{b.accountLabel}</strong><small>{b.balanceDate
            ? `As of ${new Date(b.balanceDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}${b.source === 'activity' ? ' · activity balance' : ''}`
            : 'No cash balance in uploaded statements'}</small></div>
          <div className="investment-cash-account-amount"><strong className={b.balance !== null && b.balance < 0 ? 'neg' : ''}>{b.balance === null ? 'Not reported' : formatMoney(b.balance, b.currency)}</strong>
            <small>{b.currency}{b.balance !== null && b.balance < 0 ? ' · no cash available' : ''}</small></div>
        </li>)}</ul>
      </details>}
    </article>
  );
}

export default function InvestmentCashSummary({ cash, accountId }: { cash: InvestmentReport['cash']; accountId: string }) {
  return (
    <section className="investment-cash-section" aria-label="Cash available to invest">
      <div className="investment-cash-grid">
        <CashCard title="Bank cash available to invest" description="Checking and savings cash, kept in its original currency." balances={cash.bank} />
        <CashCard title="Cash on brokers" description="Uninvested cash only. Excludes securities and margin buying power." balances={cash.broker.filter(b => !accountId || b.accountId === accountId)} />
      </div>
      <p className="investment-cash-note">Latest reported balances, independent of the portfolio period. Broker cash follows the account filter; bank cash includes all bank accounts.</p>
    </section>
  );
}
