import { useEffect, useRef, useState } from 'react';
import type { Transaction } from '../types/models';
import type { UserCategory } from '../types/categories';
import { apiFetch } from '../lib/api';
import { escapeRegex, transactionDirection } from '../lib/categories';
import RuleEditor from './RuleEditor';
import '../pages/Categories.css';

interface Props {
  transaction: Transaction;
  categories: UserCategory[];
  onClose: () => void;
  onSaved: () => void;
}

export default function TransactionCategoryEditor({ transaction, categories, onClose, onSaved }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [categoryId, setCategoryId] = useState(transaction.categoryId ?? '');
  const [rule, setRule] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const options = categories.filter(category => category.direction === transactionDirection(transaction));
  useEffect(() => { dialog.current?.showModal(); }, []);

  async function save(automatic = false) {
    setBusy(true); setError('');
    try {
      await apiFetch(`/transactions/${transaction.id}/category`, automatic ? { method: 'DELETE' } : {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ categoryId: categoryId || null }),
      });
      onSaved();
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not update category'); }
    finally { setBusy(false); }
  }

  return <dialog ref={dialog} className="category-dialog" aria-labelledby="transaction-category-title" onCancel={onClose}>
    <div className="category-section-heading"><h2 id="transaction-category-title">Categorize transaction</h2><button className="btn" aria-label="Close category editor" disabled={busy} onClick={onClose}>Close</button></div>
    <p className="category-description">{transaction.description}</p>
    {rule ? <RuleEditor initial={{ name: 'Rule from transaction', categoryId: categoryId || options[0]?.id || '', pattern: escapeRegex(transaction.description.trim().replace(/\s+/g, ' ')), accountingType: transaction.category ?? null, enabled: true }}
      categories={options} onCancel={() => setRule(false)} onSaved={onSaved} /> : <>
      <p className="muted">{transaction.categorySource === 'manual' ? 'This transaction has an individual correction.' : 'This transaction follows matching rules.'}</p>
      <form onSubmit={e => { e.preventDefault(); void save(); }}>
        <label>Category<select name="transactionCategory" value={categoryId} onChange={e => setCategoryId(e.target.value)}>
          <option value="">Uncategorized</option>{options.map(category => <option key={category.id} value={category.id}>{category.name}</option>)}
        </select></label>
        <div className="category-actions"><button className="btn primary" type="submit" disabled={busy}>Save correction</button><button className="btn" type="button" disabled={busy} onClick={() => void save(true)}>Use automatic rules</button></div>
      </form>
      <div className="category-rule-offer"><p>Apply a category to similar transactions, too.</p><button className="btn" disabled={busy || !options.length} onClick={() => setRule(true)}>Create matching rule</button></div>
    </>}
    {error && <p className="error" role="alert">{error}</p>}
  </dialog>;
}
