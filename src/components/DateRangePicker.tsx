import { useEffect, useId, useRef, useState } from 'react';
import { DayPicker, type DateRange } from 'react-day-picker';
import { formatCustomRange, formatDateInput, parseDateBound } from '../lib/dates';
import 'react-day-picker/style.css';
import './DateRangePicker.css';

interface Props {
  from: string;
  to: string;
  onChange: (from: string, to: string) => void;
}

export default function DateRangePicker({ from, to, onChange }: Props) {
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState<DateRange>();
  const [selectingEnd, setSelectingEnd] = useState(false);
  const [month, setMonth] = useState(new Date());
  const [compact, setCompact] = useState(() => window.matchMedia('(max-width: 640px)').matches);

  useEffect(() => {
    const media = window.matchMedia('(max-width: 640px)');
    const update = () => setCompact(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  const open = () => {
    const start = from ? parseDateBound(from) : undefined;
    const end = to ? parseDateBound(to) : undefined;
    setDraft(start ? { from: start, to: end } : undefined);
    setSelectingEnd(false);
    setMonth(start ?? new Date());
    dialog.current?.showModal();
  };
  const formatDay = (date?: Date) => date
    ? date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    : 'Choose a date';

  return (
    <div className="filter-group">
      <label htmlFor={`${id}-trigger`}>Date range</label>
      <button id={`${id}-trigger`} type="button" className="date-range-trigger" aria-haspopup="dialog" onClick={open}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
          <rect x="3" y="5" width="18" height="16" rx="2" />
          <path d="M16 3v4M8 3v4M3 11h18" />
        </svg>
        {formatCustomRange(from, to)}
      </button>

      <dialog ref={dialog} className="date-range-dialog" aria-labelledby={`${id}-title`} aria-describedby={`${id}-hint`}>
        <div className="date-range-heading">
          <h2 id={`${id}-title`}>Choose a date range</h2>
          <button type="button" className="date-range-close" aria-label="Close calendar" onClick={() => dialog.current?.close()}>×</button>
        </div>
        <p id={`${id}-hint`} className="date-range-hint">Select a start and end date. Select the same day twice for a single day.</p>
        <div className="date-range-preview" aria-live="polite">
          <div><span>Start date</span><strong>{formatDay(draft?.from)}</strong></div>
          <span aria-hidden="true">→</span>
          <div><span>End date</span><strong>{formatDay(draft?.to)}</strong></div>
        </div>
        <DayPicker
          mode="range"
          selected={draft}
          onSelect={(_range, day) => {
            if (selectingEnd && draft?.from) {
              setDraft(day < draft.from ? { from: day, to: draft.from } : { from: draft.from, to: day });
              setSelectingEnd(false);
            } else {
              setDraft({ from: day, to: undefined });
              setSelectingEnd(true);
            }
          }}
          month={month}
          onMonthChange={setMonth}
          numberOfMonths={compact ? 1 : 2}
          captionLayout="dropdown"
          navLayout="after"
          startMonth={new Date(1900, 0)}
          endMonth={new Date(new Date().getFullYear() + 5, 11)}
          fixedWeeks
        />
        <div className="date-range-actions">
          <button type="button" className="btn" onClick={() => dialog.current?.close()}>Cancel</button>
          <button
            type="button"
            className="btn primary"
            disabled={!draft?.from || !draft?.to}
            onClick={() => {
              if (!draft?.from || !draft?.to) return;
              onChange(formatDateInput(draft.from), formatDateInput(draft.to));
              dialog.current?.close();
            }}
          >Apply range</button>
        </div>
      </dialog>
    </div>
  );
}
