import { useEffect, useRef, useState } from 'react';
import type { Transaction } from '../types/models';
import { apiFetch } from '../lib/api';
import { formatMoney } from '../lib/finance';

interface Props {
  transaction: Transaction;
  onClose: () => void;
  onDeleted: () => void;
}

export default function TransactionDeleteDialog({ transaction, onClose, onDeleted }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { dialog.current?.showModal(); }, []);

  async function remove() {
    setBusy(true);
    setError('');
    try {
      await apiFetch(`/transactions/${encodeURIComponent(transaction.id)}`, { method: 'DELETE' });
      onDeleted();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not delete transaction');
      setBusy(false);
    }
  }

  return <dialog ref={dialog} className="transaction-delete-dialog" aria-labelledby="transaction-delete-title"
    aria-describedby="transaction-delete-note" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <h2 id="transaction-delete-title">Delete transaction?</h2>
    <p className="transaction-delete-description">{transaction.description}</p>
    <p>{new Date(transaction.date).toLocaleDateString()} · {formatMoney(transaction.amount, transaction.currency)}</p>
    <p id="transaction-delete-note">This will remove the transaction from your totals and lists. Uploading the same statement again won’t restore it. This cannot be undone.</p>
    {error && <p className="error" role="alert">{error}</p>}
    <div className="transaction-delete-actions">
      <button className="btn" autoFocus disabled={busy} onClick={onClose}>Cancel</button>
      <button className="btn danger" disabled={busy} onClick={() => void remove()}>{busy ? 'Deleting…' : 'Delete transaction'}</button>
    </div>
  </dialog>;
}
