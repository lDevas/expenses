import { useId } from 'react';
import { getDefaultFilterValue, getRecentMonths, getYearsLast5, type FilterType } from '../lib/dates';
import DateRangePicker from './DateRangePicker';

interface Props {
  type: FilterType;
  value: string;
  customFrom: string;
  customTo: string;
  onChange: (type: FilterType, value: string) => void;
  onCustomChange: (from: string, to: string) => void;
}

export default function PeriodFilter({ type, value, customFrom, customTo, onChange, onCustomChange }: Props) {
  const id = useId();
  const months = getRecentMonths();

  return (
    <>
      <div className="filter-group">
        <label htmlFor={id}>Period</label>
        <select
          id={id}
          name="period"
          value={type === 'month' ? value : type}
          onChange={e => {
            const selected = e.target.value;
            if (months.some(month => month.value === selected)) onChange('month', selected);
            else {
              const nextType = selected as FilterType;
              onChange(nextType, getDefaultFilterValue(nextType));
            }
          }}
        >
          <option value="ytd">Year to Date</option>
          {months.map((month, index) => (
            <option key={month.value} value={month.value}>
              {month.label}{index === 0 ? ' (current month)' : ''}
            </option>
          ))}
          <option value="year">Year</option>
          <option value="custom">Custom Range</option>
        </select>
      </div>

      {type === 'year' && (
        <div className="filter-group">
          <label htmlFor={`${id}-year`}>Select Year</label>
          <select id={`${id}-year`} name="year" value={value} onChange={e => onChange('year', e.target.value)}>
            {getYearsLast5().map(year => (
              <option key={year.value} value={year.value}>{year.label}</option>
            ))}
          </select>
        </div>
      )}

      {type === 'custom' && (
        <DateRangePicker from={customFrom} to={customTo} onChange={onCustomChange} />
      )}
    </>
  );
}
