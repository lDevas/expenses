import * as XLSX from 'xlsx';
import {
  parseAmount,
  parseStatementDate,
  toISODate,
  type Issue,
  type ParsedAccount,
  type ParsedStatement,
  type RawTxn,
  type RawTxnKind,
} from '../types.ts';

/**
 * Prex (prexcard.com) "Estado de cuenta" bank statement (.xlsx).
 *
 * Layout (single sheet, e.g. "Estado de cuenta"):
 *   Fecha | Descripción | Moneda Origen | Importe Origen | Moneda | Importe | Estado
 *
 * Quirks handled:
 *  - One account holds multiple currencies (UYU/USD/…). Returns one statement per
 *    observed currency (prex-uyu, prex-usd, …), following the one-currency-per-
 *    account convention of the Itau/Santander ledger accounts.
 *  - The file has no account number, holder, balances, or statement period: account
 *    ids are fixed, coverage is inferred from activity, and balances stay unknown.
 *  - Currency conversions appear as "CAMBIO MONEDA …" debit/credit legs on the same
 *    day with no shared operation id. The parser pairs debit/credit legs per day and
 *    stamps a synthetic shared reference so consolidation can pair the legs as a
 *    currency exchange (same institution, shared reference).
 *  - `Importe` is the posted signed amount (debits negative); `Importe Origen` is kept
 *    in metadata and flagged when it differs from the posted amount.
 */
export function parsePrexXlsx(buffer: Buffer, filename: string): ParsedStatement[] {
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(buffer, { type: 'buffer' });
  } catch (e) {
    return [fatal(filename, undefined, e, 'Could not read the Excel file. Is it a valid Prex "Estado de cuenta" .xlsx?')];
  }

  const sheetName = wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  if (!ws) {
    return [fatal(filename, sheetName, new Error('empty workbook'), 'Workbook has no sheets')];
  }
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' }) as unknown[][];

  // The complete Prex column set, order-independent (accents/case insensitive).
  const norm = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const expected = ['fecha', 'descripcion', 'moneda origen', 'importe origen', 'moneda', 'importe', 'estado'];
  const headerIdx = rows.findIndex((r) => {
    const cols = r.map((c) => norm(cellText(c)));
    return expected.every((h) => cols.includes(h));
  });
  if (headerIdx < 0) {
    return [fatal(filename, sheetName, new Error('layout'),
      'Could not find the Prex header row (Fecha, Descripción, Moneda Origen, Importe Origen, Moneda, Importe, Estado) — does not look like a Prex statement')];
  }

  const header = rows[headerIdx].map((c) => norm(cellText(c)));
  const col = (name: string) => header.indexOf(name);
  const pick = (r: unknown[], name: string): string => {
    const i = col(name);
    return i >= 0 && i < r.length ? cellText(r[i]) : '';
  };

  type SourceRow = {
    rowNo: number;
    fecha: string;
    descripcion: string;
    monedaOrigen: string;
    importeOrigen: string;
    moneda: string;
    importe: string;
    estado: string;
  };

  const sourceRows: SourceRow[] = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    const row: SourceRow = {
      rowNo: i + 1,
      fecha: pick(r, 'fecha'),
      descripcion: pick(r, 'descripcion'),
      monedaOrigen: pick(r, 'moneda origen'),
      importeOrigen: pick(r, 'importe origen'),
      moneda: pick(r, 'moneda'),
      importe: pick(r, 'importe'),
      estado: pick(r, 'estado'),
    };
    if (!row.fecha && !row.descripcion && !row.importe) continue; // blank row
    sourceRows.push(row);
  }

  const issues: Issue[] = [];
  const issuesByCurrency = new Map<string, Issue[]>();
  const unassignedIssues: Issue[] = [];
  const pushIssue = (currency: string | undefined, issue: Issue) => {
    if (currency) {
      const list = issuesByCurrency.get(currency);
      if (list) list.push(issue);
      else issuesByCurrency.set(currency, [issue]);
    } else unassignedIssues.push(issue);
  };
  const warn = (row: SourceRow, currency: string | undefined, field: string, raw: string, message: string): Issue => {
    const issue: Issue = { file: filename, sheet: sheetName, row: row.rowNo, field, raw, severity: 'warning', message };
    pushIssue(currency, issue);
    return issue;
  };

  // ─── Rows → raw transactions (grouped per currency) ───
  const byCurrency = new Map<string, RawTxn[]>();
  const allTxns: RawTxn[] = [];
  let dataCount = 0;
  for (const row of sourceRows) {
    const date = parseStatementDate(row.fecha);
    if (!date) {
      warn(row, undefined, 'Fecha', row.fecha, 'Unparseable date — row skipped');
      continue;
    }
    const currency = normalizeCurrency(row.moneda);
    if (!currency) {
      warn(row, undefined, 'Moneda', row.moneda, `Unrecognized currency "${row.moneda}" — row skipped`);
      continue;
    }
    const amount = parseAmount(row.importe);
    if (amount === null) {
      warn(row, currency, 'Importe', row.importe, 'No amount found — row skipped');
      continue;
    }
    if (amount === 0) {
      warn(row, currency, 'Importe', row.importe, 'Zero amount — row skipped');
      continue;
    }

    const description = row.descripcion.replace(/\s+/g, ' ').trim();
    const [kind, counterparty] = classifyPrexDescription(description, amount);

    // Trailing operation reference (e.g. "Envío Prex a Prex ARG 11260708").
    // CAMBIO MONEDA legs carry no operation id; their shared reference is
    // synthesized below.
    const reference = kind !== 'fx' ? description.match(/(\d{5,})\s*$/)?.[1] : undefined;

    if (row.estado && !/confirmad/i.test(norm(row.estado))) {
      warn(row, currency, 'Estado', row.estado, `Status is "${row.estado}" (not confirmado) — included, but may still change`);
    }
    const origenAmount = parseAmount(row.importeOrigen);
    if (row.monedaOrigen && normalizeCurrency(row.monedaOrigen) === currency && origenAmount !== null && Math.abs(origenAmount - amount) > 0.01) {
      warn(row, currency, 'Importe Origen', `${row.importeOrigen} → ${row.importe}`, 'Origin amount differs from posted amount — using the posted amount');
    }

    const txn: RawTxn = {
      accountId: accountId(currency),
      date,
      description: description || row.estado || '(sin descripción)',
      amount,
      currency,
      kind,
      reference,
      counterparty,
      metadata: {
        raw: {
          fecha: row.fecha,
          descripcion: row.descripcion,
          monedaOrigen: row.monedaOrigen,
          importeOrigen: row.importeOrigen,
          moneda: row.moneda,
          importe: row.importe,
          estado: row.estado,
        },
      },
    };
    const list = byCurrency.get(currency);
    if (list) list.push(txn);
    else byCurrency.set(currency, [txn]);
    allTxns.push(txn);
    dataCount++;
  }

  if (dataCount === 0) {
    issues.push({ file: filename, sheet: sheetName, severity: 'warning', message: 'No transaction rows found in the statement' });
    return [emptyStatement(filename, issues)];
  }

  // ─── FX legs: pair same-day debit/credit legs with a synthetic shared reference ───
  const fxByDate = new Map<string, RawTxn[]>();
  for (const t of allTxns) {
    if (t.kind !== 'fx') continue;
    const key = toISODate(t.date);
    const list = fxByDate.get(key);
    if (list) list.push(t);
    else fxByDate.set(key, [t]);
  }
  for (const [isoDate, legs] of fxByDate) {
    const debits = legs.filter((t) => t.amount < 0);
    const credits = legs.filter((t) => t.amount > 0);
    if (debits.length === 1 && credits.length === 1) {
      const ref = `CAMBIO-${isoDate}`;
      debits[0].reference = ref;
      credits[0].reference = ref;
    } else {
      issues.push({ file: filename, sheet: sheetName, severity: 'warning',
        message: `${legs.length} CAMBIO MONEDA row${legs.length === 1 ? '' : 's'} on ${isoDate} could not be paired as a single exchange (${debits.length} debit${debits.length === 1 ? '' : 's'}, ${credits.length} credit${credits.length === 1 ? '' : 's'})` });
    }
  }

  // ─── One statement per observed currency ───
  const statements = [...byCurrency.keys()].sort().map((currency) => {
    const txns = byCurrency.get(currency)!;
    const dates = txns.map((t) => t.date);
    const account: ParsedAccount = {
      id: accountId(currency),
      institutionId: 'prex',
      institutionName: 'Prex Uruguay',
      name: `Prex cuenta (${currency})`,
      type: 'checking',
      currency,
      periodFrom: dates.reduce((min, d) => (d < min ? d : min), dates[0]),
      periodTo: dates.reduce((max, d) => (d > max ? d : max), dates[0]),
    };
    return {
      kind: 'prex-estado' as const,
      file: filename,
      account,
      transactions: txns,
      positions: [],
      realized: [],
      summary: {},
      issues: issuesByCurrency.get(currency) ?? [],
    } satisfies ParsedStatement;
  });

  // Rows skipped before a currency was known attach to the first statement.
  if (unassignedIssues.length) statements[0].issues = [...statements[0].issues, ...unassignedIssues];
  if (issues.length) statements[0].issues = [...statements[0].issues, ...issues];
  return statements;
}

/** Classify a Prex description into a semantic kind + counterparty. */
export function classifyPrexDescription(description: string, amount: number): [RawTxnKind, string | undefined] {
  const flat = description.replace(/\s+/g, ' ').trim();
  const upper = flat.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();

  if (/CAMBIO\s+(DE\s+MONEDA|MONEDA)/.test(upper)) return ['fx', undefined];
  if (/PREX\s+A\s+PREX/.test(upper)) {
    const cp = flat.match(/DE\s+(\S.*)$/i)?.[1]?.trim();
    return amount < 0 ? ['transfer-out', cp || undefined] : ['transfer-in', cp || undefined];
  }
  if (/CARGA\s+TRANSFERENCIA\s+BANCARIA/.test(upper)) return ['transfer-in', undefined];
  if (/TRANSFERENCIA\s+(SPI|TRN)/.test(upper)) return ['transfer-out', undefined];
  if (/DEVOLUCION/.test(upper)) return ['refund', undefined];
  return ['other', undefined];
}

function accountId(currency: string): string {
  return `prex-${currency.toLowerCase()}`;
}

function normalizeCurrency(raw: string): string | undefined {
  const c = cellText(raw).toUpperCase();
  return /^[A-Z]{3}$/.test(c) ? c : undefined;
}

function emptyStatement(filename: string, issues: Issue[]): ParsedStatement {
  return {
    kind: 'prex-estado',
    file: filename,
    account: {
      id: 'unknown',
      institutionId: 'prex',
      institutionName: 'Prex Uruguay',
      name: 'Prex cuenta',
      type: 'checking',
      currency: 'UYU',
    },
    transactions: [],
    positions: [],
    realized: [],
    summary: {},
    issues,
  };
}

function fatal(file: string, sheet: string | undefined, e: unknown, message: string): ParsedStatement {
  return { ...emptyStatement(file, []), issues: [{ file, sheet, severity: 'error', message: `${message} (${errMsg(e)})` }] };
}

function cellText(v: unknown): string {
  if (v === null || v === undefined) return '';
  return String(v).trim();
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
