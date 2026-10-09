import { useEffect, useRef, useState } from 'react';
import type { CategoryDirection, CategoryRule, CategoryRuleInput, CategorySummary } from '../types/categories';
import { apiFetch } from '../lib/api';
import RuleEditor from '../components/RuleEditor';
import './Categories.css';

const json = (method: string, data: unknown): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });

function CategoryRow({ category, categories, busy, mutate }: {
  category: CategorySummary; categories: CategorySummary[]; busy: boolean;
  mutate: (action: () => Promise<unknown>, message: string) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(category.name);
  const [target, setTarget] = useState('');
  const others = categories.filter(c => c.direction === category.direction && c.id !== category.id);
  return <li className="category-row" data-category-id={category.id}>
    <div className="category-row-heading"><span><strong>{category.name}</strong><small>{category.transactionCount} transactions · {category.ruleCount} rules</small></span>
      <button className="btn" onClick={() => { setName(category.name); setEditing(!editing); }} aria-label={`Edit ${category.name}`} aria-expanded={editing}>{editing ? 'Close' : 'Edit'}</button>
    </div>
    {editing && <div className="category-row-editor">
      <form onSubmit={async e => {
        e.preventDefault();
        if (await mutate(() => apiFetch(`/categories/${category.id}`, json('PUT', { name })), 'Category renamed.')) setEditing(false);
      }}>
        <label>Category name<input aria-label={`Name for ${category.name}`} value={name} maxLength={100} required onChange={e => setName(e.target.value)} /></label>
        <button className="btn" type="submit" disabled={busy}>Rename</button>
      </form>
      {others.length > 0 && <form onSubmit={e => { e.preventDefault(); void mutate(() => apiFetch(`/categories/${category.id}/merge`, json('POST', { targetId: target })), 'Categories merged. Rules and corrections now use the destination category.'); }}>
        <label>Merge into<select aria-label={`Merge ${category.name} into`} required value={target} onChange={e => setTarget(e.target.value)}>
          <option value="">Choose destination</option>{others.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select></label><button type="submit" className="btn" disabled={busy || !target}>Merge</button>
      </form>}
      <p className="muted">Merging moves all rules and individual corrections to the destination and removes this category.</p>
      {category.canDelete ? <button className="btn" disabled={busy} onClick={() => void mutate(() => apiFetch(`/categories/${category.id}`, { method: 'DELETE' }), 'Unused category deleted.')}>Delete unused category</button>
        : <p className="muted">This category is in use. Merge it to remove it.</p>}
    </div>}
  </li>;
}

export default function Categories() {
  const [categories, setCategories] = useState<CategorySummary[]>([]);
  const [rules, setRules] = useState<CategoryRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [name, setName] = useState('');
  const [direction, setDirection] = useState<CategoryDirection>('expense');
  const [editor, setEditor] = useState<{ id?: string; draft: CategoryRuleInput } | null>(null);
  const editorRef = useRef<HTMLDivElement>(null);

  async function refresh() {
    const [nextCategories, nextRules] = await Promise.all([apiFetch<CategorySummary[]>('/categories'), apiFetch<CategoryRule[]>('/category-rules')]);
    setCategories(nextCategories); setRules(nextRules);
  }
  useEffect(() => {
    let cancelled = false;
    Promise.all([apiFetch<CategorySummary[]>('/categories'), apiFetch<CategoryRule[]>('/category-rules')])
      .then(([nextCategories, nextRules]) => { if (!cancelled) { setCategories(nextCategories); setRules(nextRules); } })
      .catch(e => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => { if (editor) editorRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }); }, [editor]);

  async function mutate(action: () => Promise<unknown>, success: string): Promise<boolean> {
    setBusy(true); setError(''); setMessage('');
    try { await action(); await refresh(); setMessage(success); return true; }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not save changes'); return false; }
    finally { setBusy(false); }
  }

  async function move(index: number, step: number) {
    const ids = rules.map(rule => rule.id);
    [ids[index], ids[index + step]] = [ids[index + step], ids[index]];
    await mutate(() => apiFetch('/category-rules/order', json('PUT', { ids })), 'Rule order updated.');
  }

  return <div className="categories-page">
    <h1>Categories</h1>
    <p>Organize expenses and income. Changes apply to past and future transactions; individual corrections always take priority.</p>
    {error && <p className="error category-feedback" role="alert">{error}</p>}
    {message && <p className="category-feedback" role="status">{message}</p>}
    {loading ? <p>Loading categories…</p> : <>
      <section className="category-create" aria-labelledby="new-category-heading">
        <h2 id="new-category-heading">New category</h2>
        <form className="category-inline-form" onSubmit={async e => {
          e.preventDefault();
          if (await mutate(() => apiFetch('/categories', json('POST', { name, direction })), 'Category created.')) setName('');
        }}>
          <label>Name<input name="categoryName" value={name} maxLength={100} required placeholder="e.g. Coffee" onChange={e => setName(e.target.value)} /></label>
          <label>Type<select name="categoryDirection" value={direction} onChange={e => setDirection(e.target.value as CategoryDirection)}><option value="expense">Expenses</option><option value="income">Income</option></select></label>
          <button className="btn primary" disabled={busy} type="submit">Create category</button>
        </form>
      </section>
      <div className="category-columns">
        {(['expense', 'income'] as const).map(type => <section key={type} aria-label={`${type} categories`}>
          <h2>{type === 'expense' ? 'Expenses' : 'Income'} <small className="muted">{categories.filter(c => c.direction === type).length}</small></h2>
          <ul className="category-list">{categories.filter(c => c.direction === type).map(category =>
            <CategoryRow key={category.id} category={category} categories={categories} busy={busy} mutate={mutate} />)}</ul>
        </section>)}
      </div>
      <section aria-labelledby="rules-heading">
        <div className="category-section-heading"><h2 id="rules-heading">Matching rules</h2><button className="btn primary" disabled={!!editor || !categories.length} onClick={() => setEditor({ draft: {
          name: 'New rule', categoryId: '', pattern: '', accountingType: null, enabled: true,
        } })}>New rule</button></div>
        <p className="muted">First enabled match wins. More specific rules should come before broader ones.</p>
        <div ref={editorRef}>{editor && <RuleEditor key={editor.id ?? 'new'} initial={editor.draft} ruleId={editor.id} categories={categories}
          onCancel={() => setEditor(null)} onSaved={() => { setEditor(null); void mutate(async () => {}, 'Rule saved. Automatic categories are up to date.'); }} />}</div>
        <ol className="rule-list">
          {rules.map((rule, index) => {
            const category = categories.find(c => c.id === rule.categoryId);
            return <li key={rule.id} data-rule-id={rule.id} className={rule.enabled ? '' : 'rule-disabled'}>
              <div className="rule-order"><span>{index + 1}</span><button className="btn" aria-label={`Move ${rule.name} up`} disabled={busy || index === 0 || !!editor} onClick={() => void move(index, -1)}>↑</button><button className="btn" aria-label={`Move ${rule.name} down`} disabled={busy || index === rules.length - 1 || !!editor} onClick={() => void move(index, 1)}>↓</button></div>
              <div className="rule-content"><strong>{rule.name}</strong><span>{category?.direction === 'income' ? 'Income' : 'Expenses'} → {category?.name}{rule.accountingType ? ` · ${rule.accountingType}` : ''}</span><code>{rule.pattern}</code></div>
              <div className="rule-actions"><label className="category-checkbox"><input type="checkbox" aria-label={`Enable ${rule.name}`} checked={rule.enabled} disabled={busy || !!editor} onChange={() => void mutate(() => apiFetch(`/category-rules/${rule.id}`, json('PUT', { ...rule, enabled: !rule.enabled })), 'Rule updated.')} />Enabled</label>
                <button className="btn" disabled={busy || !!editor} aria-label={`Edit rule ${rule.name}`} onClick={() => setEditor({ id: rule.id, draft: rule })}>Edit</button>
                <button className="btn" disabled={busy || !!editor} aria-label={`Delete rule ${rule.name}`} onClick={() => void mutate(() => apiFetch(`/category-rules/${rule.id}`, { method: 'DELETE' }), 'Rule deleted. Transactions now use the remaining rules.')}>Delete</button>
              </div>
            </li>;
          })}
        </ol>
      </section>
    </>}
  </div>;
}
