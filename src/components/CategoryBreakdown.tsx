import { useMemo, useState } from 'react';
import {
  ResponsiveContainer, PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis, Tooltip, Legend,
} from 'recharts';
import { formatMoney, toChartData, type ChartDatum, type CategoryAgg, type FxInfo } from '../lib/finance';

const PALETTE = [
  '#8b5cf6', '#3b82f6', '#10b981', '#f59e0b', '#ef4444',
  '#06b6d4', '#ec4899', '#84cc16', '#f97316', '#64748b',
  '#94a3b8', '#6366f1', '#14b8a6', '#eab308', '#78716c',
];

const CURRENCY_COLORS: Record<string, string> = {
  UYU: '#10b981',
  USD: '#3b82f6',
};

function colorForIndex(i: number): string {
  return PALETTE[i % PALETTE.length];
}

function colorForCurrency(ccy: string, i: number): string {
  return CURRENCY_COLORS[ccy] ?? PALETTE[(i + 5) % PALETTE.length];
}

type View = 'pie' | 'bar';

interface CategoryBreakdownProps {
  title: string;
  tone: 'expense' | 'income';
  slices: CategoryAgg[];
  fx: FxInfo | null;
}

export default function CategoryBreakdown({ title, tone, slices, fx }: CategoryBreakdownProps) {
  const [view, setView] = useState<View>('pie');
  const [selected, setSelected] = useState<CategoryAgg | null>(null);

  const aggs = selected ? Object.values(selected.subcategories) : slices;
  const { items, currency } = useMemo(() => toChartData(aggs, fx), [aggs, fx]);
  const total = items.reduce((a, d) => a + (d.value ?? 0), 0);

  const drillable = useMemo(() => {
    const set = new Set<string>();
    for (const a of aggs) if (Object.keys(a.subcategories).length > 0) set.add(a.name);
    return set;
  }, [aggs]);

  const ccySeries = useMemo(() => {
    const set = new Set<string>();
    for (const d of items) for (const c of Object.keys(d.perCurrency)) set.add(c);
    return [...set].sort();
  }, [items]);

  const barItems = useMemo(
    () =>
      items.map((d) => {
        const row: Record<string, number | string | ChartDatum> = { name: d.name, datum: d };
        for (const c of ccySeries) {
          const key = fx && c === 'UYU' ? `${c} (converted)` : c;
          const raw = d.perCurrency[c] ?? 0;
          row[key] = fx && c === 'UYU' ? raw * fx.usdPerUyu : raw;
        }
        return row;
      }),
    [items, ccySeries, fx],
  );

  const drillFromName = (name?: string | null) => {
    if (!name) return;
    const agg = aggs.find((a) => a.name === name);
    if (!agg || Object.keys(agg.subcategories).length === 0) return;
    setSelected((cur) => (cur?.name === agg.name ? null : agg));
  };

  const renderTooltip = (props: any) => {
    const { active, payload, label } = props;
    if (!active || !payload?.length) return null;
    const datum: ChartDatum | undefined = (payload[0] as any)?.payload?.datum ?? (payload[0] as any)?.payload;
    if (!datum) return null;

    const rows = Object.entries(datum.perCurrency);
    const share = total > 0 && datum.value !== null ? (datum.value / total) * 100 : null;

    return (
      <div className="chart-tooltip">
        <div className="tt-name">{String(label ?? datum.name)}</div>
        {rows.map(([ccy, amt]) => (
          <div key={ccy} className="tt-row">
            <span>{ccy}</span>
            <span>{formatMoney(amt, ccy)}</span>
          </div>
        ))}
        {fx && datum.perCurrency['UYU'] !== undefined && (
          <div className="tt-row">
            <span>UYU (converted)</span>
            <span>{formatMoney(datum.perCurrency['UYU'] * fx.usdPerUyu, 'USD')}</span>
          </div>
        )}
        {fx && (
          <div className="tt-row tt-total">
            <span>Total (USD)</span>
            <span>{formatMoney(datum.usd, 'USD')}</span>
          </div>
        )}
        {share !== null && (
          <div className="tt-row tt-total">
            <span>Share</span>
            <span>{share.toFixed(1)}%</span>
          </div>
        )}
        <div className="tt-row tt-count">{datum.count} transaction{datum.count === 1 ? '' : 's'}</div>
      </div>
    );
  };

  const compact = (v: number) =>
    new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(v);

  if (items.length === 0) {
    return (
      <section className={`chart-panel tone-${tone}`}>
        <div className="chart-panel-header">
          <h3>{title}</h3>
        </div>
        <p className="muted">No {title.toLowerCase()} in this period.</p>
      </section>
    );
  }

  return (
    <section className={`chart-panel tone-${tone}`}>
      <div className="chart-panel-header">
        <h3>
          {title}
          {selected ? <span className="muted"> · {selected.name}</span> : null}
        </h3>
        {selected && (
          <button className="btn chart-back" onClick={() => setSelected(null)}>
            All categories
          </button>
        )}
        <div className="chart-tabs">
          <button className={`chart-tab ${view === 'pie' ? 'active' : ''}`} onClick={() => setView('pie')}>
            Pie
          </button>
          <button className={`chart-tab ${view === 'bar' ? 'active' : ''}`} onClick={() => setView('bar')}>
            Bar
          </button>
        </div>
      </div>

      <div className="chart-box">
        {view === 'pie' ? (
          currency ? (
            <>
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={items}
                    dataKey="value"
                    nameKey="name"
                    innerRadius="58%"
                    outerRadius="85%"
                    paddingAngle={2}
                    onClick={(entry: any) => drillFromName(entry?.name ?? entry?.payload?.name)}
                  >
                    {items.map((d, i) => (
                      <Cell key={d.name} fill={colorForIndex(i)} />
                    ))}
                  </Pie>
                  <Tooltip content={renderTooltip as any} />
                </PieChart>
              </ResponsiveContainer>
              <div className="chart-center">
                <span className="total">{formatMoney(total, currency)}</span>
                <span className="label">Total</span>
              </div>
            </>
          ) : (
            <div className="chart-fallback">
              <p>Mixed currencies with no FX rate available — switch to the bar view to compare per-currency amounts.</p>
            </div>
          )
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={barItems} margin={{ top: 8, right: 8, left: 0, bottom: 8 }}>
              <XAxis dataKey="name" tick={{ fontSize: 11, fill: '#8b8b96' }} interval={0} />
              <YAxis tick={{ fontSize: 11, fill: '#8b8b96' }} tickFormatter={compact} width={48} />
              <Tooltip content={renderTooltip as any} cursor={{ fill: 'rgba(128, 128, 128, 0.08)' }} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              {ccySeries.map((c, i) => (
                <Bar
                  key={c}
                  dataKey={fx && c === 'UYU' ? `${c} (converted)` : c}
                  stackId="stack"
                  fill={colorForCurrency(c, i)}
                  maxBarSize={40}
                  onClick={(entry: any) => drillFromName(entry?.payload?.name ?? entry?.name)}
                />
              ))}
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>

      {view === 'bar' && fx && ccySeries.includes('UYU') && (
        <p className="chart-note">UYU segments converted to USD at the latest rate ({fx.uyuPerUsd.toFixed(2)} UYU/USD).</p>
      )}

      <ul className="chart-rows">
        {items.map((d, i) => (
          <li
            key={d.name}
            className={drillable.has(d.name) ? 'chart-row' : 'chart-row no-drill'}
            onClick={() => drillFromName(d.name)}
          >
            <span className="dot" style={{ background: colorForIndex(i) }} />
            <span className="name" title={d.name}>{d.name}</span>
            <span className="val">
              {view === 'pie' && d.value !== null && currency
                ? `${total > 0 ? ((d.value / total) * 100).toFixed(1) + '% ' : ''}${formatMoney(d.value, currency)}`
                : Object.entries(d.perCurrency)
                    .map(([c, amt]) => formatMoney(amt, c))
                    .join(' · ')}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
