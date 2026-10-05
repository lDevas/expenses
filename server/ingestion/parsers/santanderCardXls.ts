import * as XLSX from 'xlsx';
import {
  parseAmount,
  parseStatementDate,
  type Issue,
  type ParsedStatement,
  type RawTxnKind,
} from '../types.ts';

/**
 * Santander Visa credit card statement ("CreditCardsCurrentMovementsDetail.xls", non-standard OLE).
 *
 * Columns: Fecha | Número de tarjeta | (blank) | Descripción | (blank) | Pesos | (blank) | Dólares | (blank)
 * Sign convention: **positive = purchase** (debt up), **negative = payment/credit into the card**.
 * Billing currency per row = whichever of Pesos / Dólares is non-zero.
 */
export function parseSantanderCardXls(buffer: Buffer, filename: string): ParsedStatement {
  const issues: Issue[] = [];
  const result: ParsedStatement = {
    kind: 'santander-card',
    file: filename,
    account: {
      id: 'santander-card-unknown',
      institutionId: 'santander-uy',
      institutionName: 'Santander Uruguay',
      name: 'Santander Visa',
      type: 'credit',
      currency: 'UYU',
    },
    transactions: [],
    positions: [],
    realized: [],
    summary: {},
    issues,
  };

  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(buffer, { type: 'buffer' });
  } catch (e) {
    issues.push({ file: filename, severity: 'error', message: `Could not read the Excel file: ${errMsg(e)}` });
    return result;
  }
  const sheetName = wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  if (!ws) {
    issues.push({ file: filename, sheet: sheetName, severity: 'error', message: 'Workbook has no sheets' });
    return result;
  }
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' }) as unknown[][];
  const acc = result.account;

  const headerIdx = rows.findIndex((r) => r.some((c) => cellText(c) === 'Fecha') && r.some((c) => cellText(c) === 'Descripción'));
  if (headerIdx < 0) {
    issues.push({ file: filename, sheet: sheetName, severity: 'error', message: 'Could not find the header row (Fecha / Descripción / Pesos / Dólares)' });
    return result;
  }
  const header = rows[headerIdx].map((c) => cellText(c));
  const col = (name: string) => header.findIndex((h) => h.toLowerCase() === name.toLowerCase());
  const iDate = col('Fecha');
  const iNumber = col('Número de tarjeta');
  const iDesc = col('Descripción');
  const iPesos = col('Pesos');
  const iDolares = col('Dólares');
  const cell = (r: unknown[], i: number) => (i >= 0 && i < r.length ? cellText(r[i]) : '');

  // Meta block: a label row ("Número de tarjeta de crédito" | "Alias" | …) with the values
  // on the NEXT row, in the same columns ("XXXXX-8174" | "Visa Soy Santander" | …).
  for (let i = 0; i < headerIdx; i++) {
    const r = rows[i].map((c) => cellText(c));
    const labelCol = r.findIndex((t) => /tarjeta de crédito/i.test(t));
    if (labelCol >= 0) {
      const next = i + 1 < rows.length ? rows[i + 1].map((c) => cellText(c)) : [];
      const aliasCol = r.findIndex((t) => /^alias$/i.test(t));
      const alias = aliasCol >= 0 ? next[aliasCol] || '' : '';
      const number = (next[labelCol] || r[labelCol]).replace(/^X+-?/i, '');
      if (number && /[\d]/.test(number)) {
        acc.number = number;
        acc.id = `santander-card-${number.slice(-4)}`;
        acc.name = alias ? `Visa *${acc.number.slice(-4)}* (${alias})` : `Visa *${acc.number.slice(-4)}*`;
      }
    }
    if (!acc.holder) {
      const hCol = r.findIndex((t) => /^cliente:/i.test(t));
      if (hCol >= 0) acc.holder = r[hCol].replace(/^cliente:\s*/i, '');
    }
  }

  let matched = 0;
  let netPesos = 0;
  let netDollars = 0;
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    const date = parseStatementDate(cell(r, iDate));
    if (!date) {
      if (cell(r, iDesc)) issues.push({ file: filename, sheet: sheetName, row: i + 1, field: 'Fecha', raw: cell(r, iDate), severity: 'warning', message: 'Unparseable date — row skipped' });
      continue;
    }
    const pesos = parseAmount(cell(r, iPesos));
    const dolares = parseAmount(cell(r, iDolares));
    const desc = cell(r, iDesc);
    if (!desc && (pesos ?? 0) === 0 && (dolares ?? 0) === 0) continue;

    let amount: number;
    let currency: string;
    if ((pesos ?? 0) !== 0 && (dolares ?? 0) !== 0) {
      issues.push({ file: filename, sheet: sheetName, row: i + 1, field: 'Pesos/Dólares', raw: `${cell(r, iPesos)} / ${cell(r, iDolares)}`, severity: 'warning', message: 'Row has both Pesos and Dólares amounts — using Pesos' });
      amount = pesos ?? 0;
      currency = 'UYU';
    } else if ((pesos ?? 0) !== 0) {
      amount = pesos!;
      currency = 'UYU';
    } else if ((dolares ?? 0) !== 0) {
      amount = dolares!;
      currency = 'USD';
    } else {
      continue;
    }

    // negative = payment/credit into the card; positive = purchase
    const kind: RawTxnKind = amount < 0 ? 'card-payment' : 'purchase';
    if (amount > 0) {
      if (currency === 'UYU') netPesos += amount;
      else netDollars += amount;
    }

    result.transactions.push({
      accountId: acc.id,
      date,
      description: desc || '(sin descripción)',
      amount,
      currency,
      kind,
      counterparty: 'Santander Visa',
      metadata: { raw: { fecha: cell(r, iDate), numero: cell(r, iNumber), descripcion: desc, pesos: cell(r, iPesos), dolares: cell(r, iDolares) } },
    });
    matched++;
  }

  if (matched > 0) {
    result.summary['card net UYU'] = Math.round(netPesos * 100) / 100;
    result.summary['card net USD'] = Math.round(netDollars * 100) / 100;
    const dates = result.transactions.map((t) => t.date);
    acc.periodFrom = new Date(Math.min(...dates.map((d) => d.getTime())));
    acc.periodTo = new Date(Math.max(...dates.map((d) => d.getTime())));
  } else {
    issues.push({ file: filename, sheet: sheetName, severity: 'warning', message: 'No transaction rows found' });
  }
  return result;
}

function cellText(v: unknown): string {
  if (v === null || v === undefined) return '';
  return String(v).trim();
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
