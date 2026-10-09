import Papa from 'papaparse';
import {
  parseAmount,
  parseStatementDate,
  type Issue,
  type ParsedPosition,
  type ParsedRealized,
  type ParsedStatement,
  type RawTxn,
} from '../types.ts';

/**
 * Interactive Brokers activity statement (sectioned CSV, UTF-8 BOM, plain ASCII).
 *
 * Layout: column 0 = section name, column 1 = row role ("Header" | "Data" | "SubTotal" | "Total"),
 * the rest = values. Each section repeats its own column header on its "Header" row,
 * so every section is read by name.
 */
export function parseIbkrCsv(buffer: Buffer, filename: string): ParsedStatement {
  const issues: Issue[] = [];
  const result: ParsedStatement = {
    kind: 'ibkr-statement',
    file: filename,
    account: {
      id: 'ibkr-unknown',
      institutionId: 'interactive-brokers',
      institutionName: 'Interactive Brokers',
      name: 'IBKR account',
      type: 'investment',
      currency: 'USD',
    },
    transactions: [],
    positions: [],
    realized: [],
    summary: {},
    issues,
  };

  const text = buffer.toString('utf8').replace(/^\uFEFF/, '');
  let parsed: Papa.ParseResult<unknown[]>;
  try {
    parsed = Papa.parse<unknown[]>(text, { delimiter: ',', skipEmptyLines: 'greedy' });
  } catch (e) {
    issues.push({ file: filename, severity: 'error', message: `Could not parse CSV: ${errMsg(e)}` });
    return result;
  }
  for (const err of parsed.errors.slice(0, 5)) {
    issues.push({ file: filename, row: err.row, severity: 'warning', message: `CSV parse notice: ${err.message}` });
  }

  interface Section {
    headers: string[];
    rows: string[][];
  }
  const sections = new Map<string, Section>();
  for (const raw of parsed.data as unknown[][]) {
    if (!raw || raw.length < 3) continue;
    const section = cellText(raw[0]);
    if (!section) continue;
    const role = cellText(raw[1]);
    const values = raw.slice(2).map(cellText);
    let sec = sections.get(section);
    if (!sec) {
      sec = { headers: [], rows: [] };
      sections.set(section, sec);
    }
    // IBKR appends a one-column performance subtable in the NAV section. It
    // must not overwrite the cash/stock table's column headers above it.
    if (role === 'Header' && !(section === 'Net Asset Value' && !values.includes('Current Total'))) sec.headers = values;
    else if (role === 'Data') sec.rows.push(values);
  }

  const val = (sec: Section | undefined, row: string[], name: string): string => {
    if (!sec) return '';
    let i = sec.headers.findIndex((h) => h.toLowerCase() === name.toLowerCase());
    if (i < 0) i = sec.headers.findIndex((h) => h.toLowerCase().startsWith(name.toLowerCase()));
    return i >= 0 && i < row.length ? row[i] : '';
  };

  const kv = (name: string): Record<string, string> => {
    const sec = sections.get(name);
    const out: Record<string, string> = {};
    if (!sec) return out;
    for (const row of sec.rows) {
      const key = row[0];
      if (key) out[key] = row.slice(1).join(' ').trim();
    }
    return out;
  };

  // ─── Account Information ───
  const info = kv('Account Information');
  const acc = result.account;
  if (info['Account']) {
    acc.number = info['Account'];
    acc.id = `ibkr-${info['Account']}`;
  }
  if (info['Name']) acc.holder = info['Name'];
  if (info['Base Currency']) acc.currency = info['Base Currency'];
  acc.name = `${info['Account'] ?? 'IBKR'} (${[info['Account Type'], info['Account Capabilities']].filter(Boolean).join(', ') || 'account'})`.trim();

  // ─── Statement → period ───
  const stmt = kv('Statement');
  if (stmt['Period']) {
    const parts = stmt['Period'].split('-').map((s) => s.trim());
    if (parts.length >= 2) {
      acc.periodFrom = parseStatementDate(parts[0]) ?? undefined;
      acc.periodTo = parseStatementDate(parts[parts.length - 1]) ?? undefined;
      if (acc.periodFrom && acc.periodTo) acc.periodSource = 'statement';
    }
  }

  // ─── Net Asset Value ───
  const nav = sections.get('Net Asset Value');
  if (nav) {
    for (const row of nav.rows) {
      const label = row[0];
      if (!label) continue;
      for (const [header, key] of [['Prior Total', 'prior'], ['Current Total', 'total'], ['Change', 'change']] as const) {
        const n = num(val(nav, row, header));
        if (n !== null) result.summary[`NAV ${label} ${key}`] = n;
      }
    }
  }

  // ─── Change in NAV ───
  const change: Record<string, number | undefined> = {};
  for (const [k, v] of Object.entries(kv('Change in NAV'))) {
    const n = num(v);
    if (n !== null) change[k] = n;
  }
  for (const [k, v] of Object.entries(change)) {
    if (v !== undefined) result.summary[`Change in NAV: ${k}`] = v;
  }
  const snapshotDate = acc.periodTo ?? new Date();

  // ─── Open Positions ───
  const pos = sections.get('Open Positions');
  if (pos) {
    for (const row of pos.rows) {
      if (val(pos, row, 'DataDiscriminator') !== 'Summary') continue; // skip Total rows
      const symbol = val(pos, row, 'Symbol');
      const q = num(val(pos, row, 'Quantity'));
      if (!symbol || q === null || q === 0) continue;
      const costBasis = num(val(pos, row, 'Cost Basis')) ?? undefined;
      const value = num(val(pos, row, 'Value')) ?? undefined;
      const unrealized = num(val(pos, row, 'Unrealized P/L')) ?? (costBasis !== undefined && value !== undefined ? value - costBasis : undefined);
      const p: ParsedPosition = {
        accountId: acc.id,
        symbol,
        name: symbol,
        qty: q,
        costBasis,
        value,
        unrealizedPl: unrealized,
        snapshotDate,
        currency: val(pos, row, 'Currency') || acc.currency,
        metadata: {
          assetClass: val(pos, row, 'Asset Category'),
          costPrice: num(val(pos, row, 'Cost Price')) ?? undefined,
          closePrice: num(val(pos, row, 'Close Price')) ?? undefined,
        },
      };
      result.positions.push(p);
    }
  }

  // ─── Trades ───
  const trades = sections.get('Trades');
  if (trades) {
    for (const row of trades.rows) {
      if (val(trades, row, 'DataDiscriminator') !== 'Order') continue; // skip SubTotal/Total
      const symbol = val(trades, row, 'Symbol');
      const dateTime = val(trades, row, 'Date/Time');
      const date = parseStatementDate(dateTime.replace(', ', ' '));
      if (!symbol || !date) {
        issues.push({ file: filename, sheet: 'Trades', field: 'Date/Time', raw: dateTime, severity: 'warning', message: `Trade row skipped (missing symbol/date): ${dateTime}` });
        continue;
      }
      const qty = num(val(trades, row, 'Quantity'));
      const proceeds = num(val(trades, row, 'Proceeds'));
      const comm = num(val(trades, row, 'Comm/Fee'));
      const pl = num(val(trades, row, 'Realized P/L'));
      const basis = num(val(trades, row, 'Basis'));
      const tPrice = num(val(trades, row, 'T. Price'));
      const code = val(trades, row, 'Code') || undefined;
      const currency = val(trades, row, 'Currency') || acc.currency;
      const realized: ParsedRealized = {
        accountId: acc.id,
        symbol,
        name: symbol,
        date,
        qty: qty ?? undefined,
        proceeds: proceeds ?? undefined,
        costBasis: basis ?? undefined,
        realizedPl: pl ?? 0,
        currency,
        metadata: { tPrice: tPrice ?? undefined, comm: comm ?? undefined, code, side: (qty ?? 0) < 0 ? 'sell' : 'buy' },
      };
      result.realized.push(realized);
      result.transactions.push({
        accountId: acc.id,
        date,
        description: `${(qty ?? 0) < 0 ? 'Sell' : 'Buy'} ${symbol} (${qty} sh)`,
        amount: round2((proceeds ?? 0) + (comm ?? 0)),
        currency,
        kind: 'trade',
        reference: symbol,
        metadata: { code: val(trades, row, 'Code') || undefined, realizedPl: pl ?? 0 },
      });
    }
  }

  // ─── Deposits & Withdrawals ───
  const dw = sections.get('Deposits & Withdrawals');
  if (dw) {
    for (const row of dw.rows) {
      const date = parseStatementDate(val(dw, row, 'Settle Date'));
      const amt = num(val(dw, row, 'Amount'));
      if (!date || amt === null || amt === 0) continue;
      result.transactions.push({
        accountId: acc.id,
        date,
        description: val(dw, row, 'Description') || (amt > 0 ? 'Deposit' : 'Withdrawal'),
        amount: amt,
        currency: val(dw, row, 'Currency') || acc.currency,
        kind: amt > 0 ? 'deposit' : 'withdrawal',
        metadata: { raw: row.join(' | ') },
      });
    }
  }

  // ─── Fees ───
  const fees = sections.get('Fees');
  if (fees) {
    for (const row of fees.rows) {
      const date = parseStatementDate(val(fees, row, 'Date'));
      const amt = num(val(fees, row, 'Amount'));
      if (!date || amt === null) continue;
      result.transactions.push({
        accountId: acc.id,
        date,
        description: [val(fees, row, 'Subtitle'), val(fees, row, 'Description')].filter(Boolean).join(' — '),
        amount: amt,
        currency: val(fees, row, 'Currency') || acc.currency,
        kind: 'fee',
        metadata: { raw: row.join(' | ') },
      });
    }
  }

  // ─── Dividends + Withholding Tax ───
  const dividends = sections.get('Dividends');
  if (dividends) {
    for (const row of dividends.rows) {
      const date = parseStatementDate(val(dividends, row, 'Date'));
      const amt = num(val(dividends, row, 'Amount'));
      const description = val(dividends, row, 'Description') || 'Dividend';
      if (!date || amt === null) continue;
      result.transactions.push({
        accountId: acc.id,
        date,
        description,
        amount: amt,
        currency: val(dividends, row, 'Currency') || acc.currency,
        kind: 'dividend',
        counterparty: extractSymbol(description),
        metadata: { raw: row.join(' | ') },
      });
    }
  }
  const withholding = sections.get('Withholding Tax');
  if (withholding) {
    for (const row of withholding.rows) {
      const date = parseStatementDate(val(withholding, row, 'Date'));
      const amt = num(val(withholding, row, 'Amount'));
      const description = val(withholding, row, 'Description') || 'Withholding tax';
      if (!date || amt === null) continue;
      result.transactions.push({
        accountId: acc.id,
        date,
        description,
        amount: amt,
        currency: val(withholding, row, 'Currency') || acc.currency,
        kind: 'withholding',
        counterparty: extractSymbol(description),
        metadata: { raw: row.join(' | ') },
      });
    }
  }

  // ─── Cross-checks against the Change in NAV summary ───
  checkSum(issues, filename, 'Dividends', sumKind(result.transactions, 'dividend'), change['Dividends']);
  checkSum(issues, filename, 'Withholding Tax', sumKind(result.transactions, 'withholding'), change['Withholding Tax']);
  checkSum(issues, filename, 'Deposits & Withdrawals', sumKind(result.transactions, 'deposit') + sumKind(result.transactions, 'withdrawal'), change['Deposits & Withdrawals']);
  checkSum(issues, filename, 'Fees', sumKind(result.transactions, 'fee'), change['Other Fees']);

  if (!acc.periodFrom) {
    const dates = result.transactions.map((t) => t.date);
    if (dates.length > 0) {
      acc.periodFrom = new Date(Math.min(...dates.map((d) => d.getTime())));
      acc.periodTo = new Date(Math.max(...dates.map((d) => d.getTime())));
    }
  }
  return result;
}

/** "AAPL(US0378331005) Cash Dividend …" → "AAPL" */
function extractSymbol(description: string): string | undefined {
  const m = description.match(/([A-Z]{1,6})\(/);
  return m ? m[1] : undefined;
}

function sumKind(txns: RawTxn[], kind: RawTxn['kind']): number {
  return txns.filter((t) => t.kind === kind).reduce((s, t) => s + t.amount, 0);
}

function checkSum(issues: Issue[], file: string, label: string, actual: number, summary: number | undefined): void {
  if (summary === undefined) return;
  if (Math.abs(round2(actual) - summary) > 0.01) {
    issues.push({
      file,
      sheet: label,
      severity: 'warning',
      message: `Cross-check mismatch on ${label}: transactions total ${round2(actual)} but the statement summary says ${summary}`,
    });
  }
}

function num(s: string | undefined): number | null {
  if (!s) return null;
  const cleaned = s.replace(/[,%\s]/g, '');
  const n = parseFloat(cleaned);
  return isFinite(n) ? n : parseAmount(s);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function cellText(v: unknown): string {
  if (v === null || v === undefined) return '';
  return String(v).trim();
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
