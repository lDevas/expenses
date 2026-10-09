import { useEffect, useId, useState } from 'react';
import type { Account } from '../types/models';
import { apiFetch } from '../lib/api';

interface Props {
  value: string;
  onChange: (accountId: string) => void;
  disabled?: boolean;
  accounts?: Account[];
  allLabel?: string;
  showCurrency?: boolean;
}

export default function AccountFilter({ value, onChange, disabled = false, accounts: suppliedAccounts, allLabel = 'All accounts', showCurrency = true }: Props) {
  const id = useId();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Load every account, independently of the selected transaction date range.
  useEffect(() => {
    if (suppliedAccounts) return;
    let cancelled = false;
    apiFetch<Account[]>('/accounts')
      .then(data => {
        if (!cancelled) setAccounts(data);
      })
      .catch(e => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load accounts');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [suppliedAccounts]);

  const options = suppliedAccounts ?? accounts;
  const pending = !suppliedAccounts && loading;
  const loadError = suppliedAccounts ? null : error;

  return (
    <div className="filter-group">
      <label htmlFor={id}>Account</label>
      <select
        id={id}
        name="account"
        value={value}
        onChange={e => onChange(e.target.value)}
        disabled={disabled || pending || !!loadError}
        aria-busy={pending}
      >
        <option value="">{pending ? 'Loading accounts…' : allLabel}</option>
        {value && !options.some(account => account.id === value) && (
          <option value={value}>{value}</option>
        )}
        {options.map(account => (
          <option key={account.id} value={account.id}>
            {account.name}{account.accountNumber ? ` · ${account.accountNumber}` : ''}{showCurrency ? ` · ${account.currency}` : ''}
          </option>
        ))}
      </select>
      {loadError && <span className="error" role="alert">{loadError}</span>}
    </div>
  );
}
