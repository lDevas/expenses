import { useId } from 'react';
import type { CurrencyFilterValue } from '../lib/finance';

interface Props {
  value: CurrencyFilterValue;
  onChange: (currency: CurrencyFilterValue) => void;
}

export default function CurrencyFilter({ value, onChange }: Props) {
  const id = useId();
  return (
    <div className="filter-group">
      <label htmlFor={id}>Currency</label>
      <select id={id} name="currency" value={value} onChange={e => onChange(e.target.value as CurrencyFilterValue)}>
        <option value="">All currencies</option>
        <option value="UYU">UYU</option>
        <option value="USD">USD (all foreign currencies)</option>
      </select>
    </div>
  );
}
