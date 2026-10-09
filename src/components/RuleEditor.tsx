import { useEffect, useId, useState } from 'react';
import type { CategoryRuleInput, RulePreview, UserCategory } from '../types/categories';
import { apiFetch } from '../lib/api';
import { formatMoney } from '../lib/finance';

interface Props {
  initial: CategoryRuleInput;
  ruleId?: string;
  categories: UserCategory[];
  onSaved: () => void;
  onCancel: () => void;
}

export default function RuleEditor({ initial, ruleId, categories, onSaved, onCancel }: Props) {
  const id = useId();
  const [draft, setDraft] = useState(initial);
  const [previewState, setPreviewState] = useState<{ key: string; result?: RulePreview; error?: string } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const requestKey = JSON.stringify({ ...draft, id: ruleId });
  const previewing = previewState?.key !== requestKey;
  const preview = previewing ? null : previewState?.result;
  const previewError = previewing ? '' : previewState?.error;
  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    const timer = setTimeout(() => {
      apiFetch<RulePreview>('/category-rules/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: requestKey, signal: controller.signal })
        .then(result => { if (!cancelled) setPreviewState({ key: requestKey, result }); })
        .catch(e => { if (!cancelled) setPreviewState({ key: requestKey, error: e.message }); });
    }, 300);
    return () => { cancelled = true; clearTimeout(timer); controller.abort(); };
  }, [requestKey]);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true); setError('');
    try {
      await apiFetch(`/category-rules${ruleId ? `/${ruleId}` : ''}`, { method: ruleId ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(draft) });
      onSaved();
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not save rule'); }
    finally { setBusy(false); }
  }

  return <form className="rule-editor" onSubmit={save} aria-label={ruleId ? 'Edit matching rule' : 'New matching rule'}>
    <h3>{ruleId ? 'Edit rule' : 'New rule'}</h3>
    <p className="muted">Rules run from top to bottom. {ruleId ? 'This rule keeps its current position.' : 'New rules go first.'} Individual corrections stay unchanged.</p>
    <div className="category-form-grid">
      <label htmlFor={`${id}-name`}>Rule name<input id={`${id}-name`} name="ruleName" value={draft.name} maxLength={100} required onChange={e => setDraft({ ...draft, name: e.target.value })} /></label>
      <label htmlFor={`${id}-category`}>Assign category<select id={`${id}-category`} name="ruleCategory" value={draft.categoryId} required onChange={e => setDraft({ ...draft, categoryId: e.target.value })}>
        <option value="">Choose category</option>
        {(['expense', 'income'] as const).map(direction => <optgroup key={direction} label={direction === 'expense' ? 'Expenses' : 'Income'}>
          {categories.filter(category => category.direction === direction).map(category => <option key={category.id} value={category.id}>{category.name}</option>)}
        </optgroup>)}
      </select></label>
    </div>
    <label htmlFor={`${id}-pattern`}>Description pattern<textarea id={`${id}-pattern`} name="pattern" value={draft.pattern} required maxLength={1000} rows={3} spellCheck={false} onChange={e => setDraft({ ...draft, pattern: e.target.value })} /></label>
    <p className="muted">Use <code>UBER|CABIFY</code> for alternatives or <code>^DIVIDEND</code> for a description starting with DIVIDEND. Case and accents are ignored.</p>
    <div className="category-form-grid">
      <label htmlFor={`${id}-accounting`}>Reported transaction type<select id={`${id}-accounting`} value={draft.accountingType ?? ''} onChange={e => setDraft({ ...draft, accountingType: e.target.value || null })}>
        <option value="">Any</option>
        {Object.entries({ expense: 'Purchase / expense', income: 'Income', fee: 'Fee', tax: 'Tax', 'transfer-in': 'Incoming transfer', 'transfer-out': 'Outgoing transfer', 'investment-income': 'Investment income', other: 'Other' })
          .map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select></label>
      <label className="category-checkbox"><input type="checkbox" checked={draft.enabled} onChange={e => setDraft({ ...draft, enabled: e.target.checked })} />Enabled</label>
    </div>
    <div className="rule-preview" aria-live="polite" aria-busy={previewing}>
      <h4>Preview across all saved transactions</h4>
      {previewing ? <p>Checking matches…</p> : previewError ? <p className="error">{previewError}</p> : preview && <>
        <p>{preview.matchCount} matching transactions · {preview.changedCount} category changes{!draft.enabled ? ' · Rule disabled' : ''}</p>
        {preview.examples.length > 0 && <div className="table-wrap"><table>
          <thead><tr><th>Description</th><th>Current → After save</th><th className="num">Amount</th></tr></thead>
          <tbody>{preview.examples.map(row => <tr key={row.id}>
            <td>{row.description}</td><td>{row.before ?? 'Uncategorized'} → {row.after ?? 'Uncategorized'}{row.manual && <small> · Manual correction</small>}</td>
            <td className="num">{formatMoney(row.amount, row.currency)}</td>
          </tr>)}</tbody>
        </table></div>}
        {preview.examples.length === 50 && <p className="muted">Showing up to 50 examples, with category changes first.</p>}
      </>}
    </div>
    {error && <p className="error" role="alert">{error}</p>}
    <div className="category-actions"><button className="btn primary" disabled={busy || previewing || !!previewError} type="submit">{busy ? 'Saving…' : 'Save rule'}</button><button className="btn" type="button" disabled={busy} onClick={onCancel}>Cancel</button></div>
  </form>;
}
