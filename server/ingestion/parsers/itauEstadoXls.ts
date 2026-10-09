import * as XLSX from 'xlsx';
import {
  parseAmount,
  parseStatementDate,
  type Issue,
  type ParsedStatement,
  type RawTxn,
  type RawTxnKind,
} from '../types.ts';

/**
 * Itau "Estado de Cuenta" savings/checking statements (.xls, non-standard OLE/BIFF8 — read via SheetJS).
 *
 * Layout (single sheet):
 *   meta header row :  ... | "Nombre" | ... | "Tipo de cuenta" | "Moneda" | "Nro de cuenta" | ...
 *   meta value row  :  ... | holder   | ... | type            | moneda   | number        | ...
 *   column header   :  "" | Fecha | Concepto | (blank) | Débito | Crédito | Saldo | Referencia | Destino
 *   data rows       :  "" | DD/MM/YYYY | concept | ... | debit | credit | balance | ref | dest
 *
 * "SALDO ANTERIOR" / "SALDO FINAL" rows carry balances, not transactions.
 */
export function parseItauEstado(buffer: Buffer, filename: string): ParsedStatement {
  const issues: Issue[] = [];
  const result: ParsedStatement = {
    kind: 'itau-estado',
    file: filename,
    account: {
      id: 'itau-unknown',
      institutionId: 'itau-uy',
      institutionName: 'Itau Uruguay',
      name: 'Itau cuenta',
      type: 'savings',
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
    issues.push(fatal(filename, undefined, e, 'Could not read the Excel file. Is it a valid Itau "Estado de Cuenta" .xls?'));
    return result;
  }

  const sheetName = wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  if (!ws) {
    issues.push(fatal(filename, sheetName, new Error('empty workbook'), 'Workbook has no sheets'));
    return result;
  }
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' }) as unknown[][];

  let headerIdx: Map<string, number> | null = null;
  let metaIdx: Map<string, number> | null = null;
  let metaRowIdx = -1;
  let headerRowIdx = -1;

  rows.forEach((row, i) => {
    const text = row.map((c) => cellText(c));
    if (metaIdx === null && text.some((t) => t === 'Nro de cuenta')) {
      metaIdx = mapHeaders(text);
      metaRowIdx = i + 1;
      return;
    }
    if (headerIdx === null && text.some((t) => t === 'Fecha' && text.includes('Concepto'))) {
      headerIdx = mapHeaders(text);
      headerRowIdx = i;
    }
  });

  if (!headerIdx) {
    issues.push(fatal(filename, sheetName, new Error('layout'), 'Could not find the transaction header row (Fecha/Concepto)'));
    return result;
  }

  // ─── Account meta from the header block ───
  const acc = result.account;
  if (metaIdx && metaRowIdx >= 0 && metaRowIdx < rows.length) {
    const m = rows[metaRowIdx].map((c) => cellText(c));
    const nombre = get(metaIdx, m, 'Nombre');
    const tipo = get(metaIdx, m, 'Tipo de cuenta');
    const moneda = get(metaIdx, m, 'Moneda');
    const nro = get(metaIdx, m, 'Nro de cuenta');
    if (nombre) acc.holder = nombre;
    if (nro) {
      acc.number = nro;
      acc.id = `itau-${nro}`;
    }
    acc.type = /ahorro/i.test(tipo) ? 'savings' : 'checking';
    const cur = /d[oó]lar/i.test(moneda) ? 'USD' : /peso/i.test(moneda) ? 'UYU' : null;
    if (cur) acc.currency = cur;
    else issues.push(warn(filename, sheetName, metaRowIdx + 1, 'Moneda', moneda, `Unrecognized currency "${moneda}" — defaulting to ${acc.currency}`));
    acc.name = `${tipo || 'Cuenta'} ${nro || ''} (${moneda || acc.currency})`.trim();
  }

  // ─── Transactions ───
  let dataCount = 0;
  for (let i = headerRowIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    const c = (name: string) => get(headerIdx, row, name);
    const concept = c('Concepto');
    if (!concept && !c('Fecha')) continue;

    if (/SALDO ANTERIOR/i.test(concept)) {
      const bal = parseAmount(c('Saldo'));
      if (bal !== null) acc.openingBalance = bal;
      continue;
    }
    if (/SALDO FINAL/i.test(concept)) {
      const bal = parseAmount(c('Saldo'));
      if (bal !== null) acc.closingBalance = bal;
      continue;
    }

    const dateStr = c('Fecha');
    const date = parseStatementDate(dateStr);
    if (!date) {
      if (concept) issues.push(warn(filename, sheetName, i + 1, 'Fecha', String(dateStr), `Unparseable date — row skipped`));
      continue;
    }

    const debit = parseAmount(c('Débito'));
    const credit = parseAmount(c('Crédito'));
    let amount: number;
    if (debit !== null && credit !== null && debit !== 0 && credit !== 0) {
      issues.push(warn(filename, sheetName, i + 1, 'Débito/Crédito', `${c('Débito')} / ${c('Crédito')}`, 'Row has both a debit and a credit — using the debit'));
      amount = -Math.abs(debit);
    } else if (debit !== null && debit !== 0) {
      amount = -Math.abs(debit);
    } else if (credit !== null && credit !== 0) {
      amount = credit;
    } else {
      issues.push(warn(filename, sheetName, i + 1, 'Importe', `${c('Débito')} / ${c('Crédito')}`, `No amount found — row skipped`));
      continue;
    }

    const referencia = c('Referencia');
    const destino = c('Destino');
    const fullConcept = concept;
    const [kind, counterparty] = classifyItauConcept(fullConcept, referencia, destino);

    const txn: RawTxn = {
      accountId: acc.id,
      date,
      description: cleanConcept(fullConcept, referencia, destino),
      amount,
      currency: acc.currency,
      kind,
      reference: referencia || undefined,
      counterparty,
      balanceAfter: parseAmount(c('Saldo')) ?? undefined,
      metadata: { raw: { fecha: dateStr, concepto: fullConcept, debito: c('Débito'), credito: c('Crédito'), saldo: c('Saldo'), referencia, destino } },
    };
    result.transactions.push(txn);
    dataCount++;
  }

  if (dataCount === 0) {
    issues.push(warn(filename, sheetName, headerRowIdx + 1, undefined, undefined, 'No transaction rows found in the statement'));
  }

  acc.periodFrom = earliest(result.transactions);
  acc.periodTo = latest(result.transactions);
  return result;
}

/** Classify an Itau concepto into a semantic kind + counterparty account number. */
export function classifyItauConcept(concept: string, referencia: string, _destino: string): [RawTxnKind, string | undefined] {
  const c = concept.trim();
  const upper = c.toUpperCase();

  if (/^(?:DEB|CRE)\.\s*CAMBIOSCOM\./i.test(upper)) return ['fee', undefined];
  // ST debits and OP credits are interbank wires, not currency conversions.
  if (/^DEB\.\s*CAMBIOSST/i.test(upper)) return ['transfer-out', undefined];
  if (/^CRE\.\s*CAMBIOSOP/i.test(upper)) return ['transfer-in', undefined];

  const traspaso = upper.match(/TRASPASO\s+(A|DE)\s+([0-9]{5,})/i);
  if (traspaso) {
    const nro = traspaso[2].replace(/ILINK$/i, '');
    if (/CAMBIO/i.test(referencia)) return ['fx', nro];
    return [traspaso[1].toUpperCase() === 'A' ? 'transfer-out' : 'transfer-in', nro];
  }
  if (/DEB\.\s*CAMBIO/i.test(upper)) return ['fx', undefined];
  if (/DEB\.\s*VARIOS/i.test(upper)) {
    const cp = c.replace(/^DEB\.\s*VARIOS\s*/i, '').trim();
    if (/VISA/i.test(cp) && /ILINK/i.test(cp)) return ['card-payment', cp];
    return ['other', cp || undefined];
  }
  if (/REDIVA/i.test(upper)) return ['refund', undefined];
  if (/COMPRA/i.test(upper)) return ['purchase', undefined];
  if (/^DEBITO/i.test(upper) || /^DB\./i.test(upper)) return ['purchase', undefined];
  if (/^CREDITO/i.test(upper)) return ['transfer-in', undefined];
  return ['other', undefined];
}

function cleanConcept(concept: string, referencia: string, destino: string): string {
  let s = concept.replace(/\s{2,}/g, ' ').trim();
  if (destino && destino !== 'Otro') s = `${s} — ${destino}`;
  if (referencia && referencia !== 'CAMBIO') s = `${s} [${referencia}]`;
  else if (referencia === 'CAMBIO') s = `${s} [cambio]`;
  return s;
}

// ─── helpers ───

function cellText(v: unknown): string {
  if (v === null || v === undefined) return '';
  return String(v).trim();
}

function mapHeaders(row: string[]): Map<string, number> {
  const m = new Map<string, number>();
  row.forEach((t, i) => {
    if (t && !m.has(t)) m.set(t, i);
  });
  return m;
}

function get(idx: Map<string, number> | null, row: unknown[], name: string): string {
  if (!idx) return '';
  const i = idx.get(name);
  if (i === undefined || i >= row.length) return '';
  return cellText(row[i]);
}

function fatal(file: string, sheet: string | undefined, e: unknown, message: string): Issue {
  return { file, sheet, severity: 'error', message: `${message} (${errMsg(e)})` };
}

function warn(file: string, sheet: string | undefined, row: number | undefined, field: string | undefined, raw: string | undefined, message: string): Issue {
  return { file, sheet, row, field, raw, severity: 'warning', message };
}

function earliest(txns: RawTxn[]): Date | undefined {
  if (!txns.length) return undefined;
  return txns.reduce((min, t) => (t.date < min ? t.date : min), txns[0].date);
}

function latest(txns: RawTxn[]): Date | undefined {
  if (!txns.length) return undefined;
  return txns.reduce((max, t) => (t.date > max ? t.date : max), txns[0].date);
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
