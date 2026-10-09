import { useId } from 'react';
import type { UserCategory } from '../types/categories';
import { UNCATEGORIZED_FILTER, type DirectionFilter } from '../lib/categories';

interface Props {
  direction: DirectionFilter;
  categoryId: string;
  categories: UserCategory[];
  onDirectionChange: (value: DirectionFilter) => void;
  onCategoryChange: (value: string) => void;
}

export default function CategoryFilter({ direction, categoryId, categories, onDirectionChange, onCategoryChange }: Props) {
  const id = useId();
  return <>
    <div className="filter-group">
      <label htmlFor={`${id}-type`}>Type</label>
      <select id={`${id}-type`} name="direction" value={direction} onChange={e => onDirectionChange(e.target.value as DirectionFilter)}>
        <option value="">All types</option><option value="expense">Expenses</option><option value="income">Income</option>
      </select>
    </div>
    <div className="filter-group category-subfilter">
      <label htmlFor={`${id}-category`}>Categories</label>
      <select id={`${id}-category`} name="category" value={categoryId} onChange={e => onCategoryChange(e.target.value)}>
        <option value="">All categories</option><option value={UNCATEGORIZED_FILTER}>Uncategorized</option>
        {(['expense', 'income'] as const).filter(type => !direction || type === direction).map(type =>
          <optgroup label={type === 'expense' ? 'Expenses' : 'Income'} key={type}>
            {categories.filter(category => category.direction === type).map(category =>
              <option value={category.id} key={category.id}>{category.name}</option>)}
          </optgroup>)}
      </select>
    </div>
  </>;
}
