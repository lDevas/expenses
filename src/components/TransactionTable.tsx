import { useState, useEffect } from 'react';
import type { Transaction } from '../types/models';
import { apiFetch } from '../lib/api';

interface Props {
  accountId?: string;
  initialFrom?: string;
  initialTo?: string;
}

export default function TransactionTable({ accountId, initialFrom, initialTo }: Props) {
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [from, setFrom] = useState(initialFrom || '');
  const [to, setTo] = useState(initialTo || '');
  const [filterSource, setFilterSource] = useState<string>('');

  const loadTransactions = async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (accountId) params.set('account', accountId);
      if (from) params.set('from', from);
      if (to) params.set('to', to);
      if (filterSource) params.set('source', filterSource);

      const data = await apiFetch<Transaction[]>(`/transactions?${params}`);
      setTransactions(data);
    } catch (e) {
      setTransactions([]);
      setError(e instanceof Error ? e.message : 'Failed to load transactions');
    }
    setLoading(false);
  };

  useEffect(() => {
    loadTransactions();
  }, [accountId, from, to, filterSource]);

  const formatCurrency = (amount: number, currency: string) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
    }).format(amount);
  };

  return (
    <div className="transaction-table-container">
      <div className="filters">
        <input 
          type="date" 
          value={from} 
          onChange={e => setFrom(e.target.value)}
          placeholder="From"
        />
        <input 
          type="date" 
          value={to} 
          onChange={e => setTo(e.target.value)}
          placeholder="To"
        />
        <select value={filterSource} onChange={e => setFilterSource(e.target.value)}>
          <option value="">All Sources</option>
          <option value="ai-ingestion">AI Ingestion</option>
          <option value="file-upload">File Upload</option>
          <option value="manual-entry">Manual Entry</option>
        </select>
        <button onClick={loadTransactions}>Apply</button>
      </div>
      
      {loading ? (
        <p>Loading transactions...</p>
      ) : error ? (
        <p className="error">{error}</p>
      ) : transactions.length === 0 ? (
        <p className="empty">No transactions found.</p>
      ) : (
        <table className="transactions-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Description</th>
              <th>Category</th>
              <th>Amount</th>
              <th>Source</th>
            </tr>
          </thead>
          <tbody>
            {transactions.map(txn => (
              <tr key={txn.id}>
                <td>{new Date(txn.date).toLocaleDateString()}</td>
                <td title={txn.description}>{truncate(txn.description, 50)}</td>
                <td>{txn.category}</td>
                <td className={txn.amount >= 0 ? 'positive' : 'negative'}>
                  {formatCurrency(txn.amount, txn.currency)}
                </td>
                <td>
                  <span className={`source-badge ${txn.source}`}>
                    {txn.source === 'ai-ingestion' ? '🤖' : txn.source === 'file-upload' ? '📁' : '✏️'}
                    {txn.source.replace('-', ' ')}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      
      <div className="summary">
        <span>Total: {transactions.length} transactions</span>
        <span>
          Net: {formatCurrency(
            transactions.reduce((sum, t) => sum + t.amount, 0),
            transactions[0]?.currency || 'USD'
          )}
        </span>
      </div>
    </div>
  );

  function truncate(str: string, max: number): string {
    return str.length > max ? str.substring(0, max) + '...' : str;
  }
}
