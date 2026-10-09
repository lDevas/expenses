import { useMemo } from 'react';
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, Legend,
} from 'recharts';
import { formatMoney } from '../lib/finance';
import type { NetWorthLine } from '../lib/netWorth';

interface NetWorthChartProps {
  title: string;
  lines: NetWorthLine[];
  /** Shown instead of the plot when there is nothing to draw. */
  emptyMessage?: string;
  /** Optional footnote under the plot (e.g. the FX rate used). */
  note?: string | null;
}

type Row = Record<string, unknown>;
type TooltipRow = { name: string; value: number | null; currency: string; known: number; total: number };

/**
 * Step-line chart of net worth series. One snapshot per observed date is
 * carried forward (stepAfter) and unknown values stay visible as gaps.
 */
export default function NetWorthChart({ title, lines, emptyMessage = 'No data in this period.', note }: NetWorthChartProps) {
  const rows = useMemo<Row[]>(() => {
    const byDate = new Map<string, Row>();
    for (const line of lines) {
      for (const p of line.points) {
        const row = byDate.get(p.date) ?? { date: p.date };
        row[line.name] = p.value;
        row[`${line.name}::currency`] = p.currency;
        row[`${line.name}::known`] = p.known;
        row[`${line.name}::total`] = p.total;
        byDate.set(p.date, row);
      }
    }
    return [...byDate.values()].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  }, [lines]);

  const compact = (v: number) =>
    new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(v);

  // Widespread data: month-year ticks; otherwise day-month.
  const spanDays = rows.length > 1
    ? (Date.parse(`${rows[rows.length - 1].date}T00:00:00Z`) - Date.parse(`${rows[0].date}T00:00:00Z`)) / 86_400_000
    : 0;
  const monthTicks = spanDays > 180;

  const renderTooltip = (props: any) => {
    const active = Boolean(props?.active);
    const entries = (props?.payload as any[] | undefined) ?? [];
    const label = props?.label as string | undefined;
    if (!active || entries.length === 0) return null;
    const rows_ = entries.map((entry: any): TooltipRow => {
      const name = String(entry.dataKey);
      const value = entry.value as number | null;
      const currency = String(entry.payload[`${name}::currency`] ?? 'USD');
      const known = Number(entry.payload[`${name}::known`] ?? 0);
      const total = Number(entry.payload[`${name}::total`] ?? 0);
      return { name, value, currency, known, total };
    });
    return (
      <div className="chart-tooltip">
        <div className="tt-name">{String(label)}</div>
        {rows_.map(r => (
          <div key={r.name} className="tt-row">
            <span>{r.name}</span>
            <span>{r.value !== null && r.value !== undefined ? formatMoney(r.value, r.currency) : '—'}</span>
          </div>
        ))}
        {rows_.filter(r => r.total > 1 && r.known < r.total).map(r => (
          <div key={`${r.name}-count`} className="tt-row tt-count">
            <span>{r.name} reported</span>
            <span>{r.known} of {r.total} accounts</span>
          </div>
        ))}
      </div>
    );
  };

  return (
    <section className="chart-panel tone-networth">
      <div className="chart-panel-header">
        <h3>{title}</h3>
      </div>

      {rows.length === 0 ? (
        <div className="chart-box">
          <div className="chart-fallback"><p>{emptyMessage}</p></div>
        </div>
      ) : (
        <div className="chart-box">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={rows} margin={{ top: 8, right: 8, left: 8, bottom: 8 }}>
              <XAxis
                dataKey="date"
                tick={{ fontSize: 11, fill: '#8b8b96' }}
                minTickGap={24}
                tickFormatter={(v: string) => {
                  const d = new Date(`${v}T00:00:00Z`);
                  return d.toLocaleDateString('en-US', monthTicks
                    ? { month: 'short', year: '2-digit', timeZone: 'UTC' }
                    : { month: 'short', day: 'numeric', timeZone: 'UTC' });
                }}
              />
              <YAxis tick={{ fontSize: 11, fill: '#8b8b96' }} tickFormatter={compact} width={52} />
              <Tooltip content={renderTooltip as any} cursor={{ stroke: 'rgba(128, 128, 128, 0.3)' }} />
              {lines.length > 1 && <Legend wrapperStyle={{ fontSize: 12 }} />}
              {lines.map(line => (
                <Line
                  key={line.name}
                  type="stepAfter"
                  dataKey={line.name}
                  stroke={line.color}
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 3 }}
                  connectNulls={false}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {note && <p className="chart-note">{note}</p>}
    </section>
  );
}
