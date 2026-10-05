import * as XLSX from 'xlsx';
import Papa from 'papaparse';
import {
  parseAmount,
  parseStatementDate,
  type Issue,
  type ParsedStatement,
  type RawTxnKind,
} from '../types.ts';

/**
 * Santander "umsatz" account statements for "Ca Total Convenio" accounts.
 * Two shapes, one parser:
 *  - .xls (non-standard OLE/BIFF8, read via SheetJS): header block Cliente/Cuenta/Moneda/Sucursal,
 *    columns: Fecha | Referencia | Tipo Movimiento | (blank) | Descripción | Débito | (blank) | Crédito | Saldo
 *  - .csv (ISO-8859-1): header block "Cliente,…" / "Número,…" / "Moneda,…" / "Desde:,dd/mm/yyyy,Hasta:,dd/mm/yyyy",
 *    columns: Fecha | Referencia | Concepto | Descripción | Débito | Crédito | Saldos
 * Debits are stored **negative** in both shapes.
 */
export function parseSantanderUmsatz(buffer: Buffer, filename: string): ParsedStatement {
  const issues: Issue[] = [];
  const result: ParsedStatement = {
    kind: 'santander-umsatz',
    file: filename,
    account: {
      id: 'santander-unknown',
      institutionId: 'santander-uy',
      institutionName: 'Santander Uruguay',
      name: 'Santander cuenta',
      type: 'checking',
      currency: 'UYU',
    },
    transactions: [],
    positions: [],
    realized: [],
    summary: {},
    issues,
  };

  type RowMap = { date: string; ref: string; concepto: string; descripcion: string; debit: string; credit: string; saldo: string; rowNo: number };

  let rows: RowMap[] = [];
  const ext = filename.toLowerCase().split('.').pop() || '';
  const sheetName = 'umsatz';

  if (ext === 'csv') {
    const text = buffer.toString('latin1');
    try {
      const parsed = Papa.parse<unknown[]>(text, { delimiter: ',', skipEmptyLines: 'greedy' });
      if (parsed.errors.length > 0) {
        const first = parsed.errors[0];
        issues.push({ file: filename, sheet: ext, row: first.row, severity: 'warning', message: `CSV parse notice: ${first.message}` });
      }
      const grid = parsed.data as unknown[][];
      const headerIdx = grid.findIndex((r) => (r[0] as string | undefined)?.trim() === 'Fecha');
      if (headerIdx < 0) {
        issues.push({ file: filename, sheet: ext, severity: 'error', message: 'Could not find the CSV header row (Fecha, Referencia, …)' });
        return result;
      }
      const header = grid[headerIdx].map((c) => String(c ?? '').trim());
      const col = (name: string) => header.findIndex((h) => h.toLowerCase().includes(name.toLowerCase()));
      const iDate = col('Fecha');
      const iRef = col('Referencia');
      const iConcepto = col('Concepto');
      const iDesc = col('Descripción');
      const iDebit = col('Débito');
      const iCredit = col('Crédito');
      const iSaldo = col('Saldo');
      const cell = (r: unknown[], i: number) => (i >= 0 && i < r.length ? String(r[i] ?? '').trim() : '');

      // header block
      for (const r of grid.slice(0, headerIdx)) {
        const key = String(r[0] ?? '').replace(':', '').trim().toLowerCase();
        const val1 = String(r[1] ?? '').trim();
        const val2 = String(r[2] ?? '').trim();
        const acc = result.account;
        if (key === 'cliente') acc.holder = val1;
        if (key === 'cuenta' && val1) acc.name = val1;
        if (key === 'número' || key === 'numero') {
          const digits = val1.replace(/[^\d]/g, '');
          if (digits.length >= 6) {
            acc.number = digits;
            acc.id = `santander-${digits}`;
            if (acc.name && !acc.name.includes(digits)) acc.name = `${acc.name} ${digits}`.trim();
          }
        }
        if (key === 'moneda') {
          if (/USD/i.test(val1)) acc.currency = 'USD';
          else if (/UYU/i.test(val1)) acc.currency = 'UYU';
        }
        if (key === 'desde') {
          const m = (val1 + ' ' + val2).match(/(\d{2})\/(\d{2})\/(\d{4})\s*(?:hasta|,)\s*(\d{2})\/(\d{2})\/(\d{4})/i);
          if (m) {
            result.account.periodFrom = parseStatementDate(m.slice(1, 4).join('/')) ?? undefined;
            result.account.periodTo = parseStatementDate(m.slice(4, 7).join('/')) ?? undefined;
          }
        }
      }

      for (let i = headerIdx + 1; i < grid.length; i++) {
        const r = grid[i];
        const map: RowMap = {
          date: cell(r, iDate),
          ref: cell(r, iRef),
          concepto: iConcepto >= 0 ? cell(r, iConcepto) : '',
          descripcion: iDesc >= 0 ? cell(r, iDesc) : '',
          debit: cell(r, iDebit),
          credit: cell(r, iCredit),
          saldo: iSaldo >= 0 ? cell(r, iSaldo) : '',
          rowNo: i + 1,
        };
        if (!map.date) continue;
        rows.push(map);
      }
    } catch (e) {
      issues.push({ file: filename, sheet: ext, severity: 'error', message: `Failed to parse CSV: ${errMsg(e)}` });
      return result;
    }
  } else {
    let sheet = sheetName;
    let wb: XLSX.WorkBook;
    try {
      wb = XLSX.read(buffer, { type: 'buffer' });
    } catch (e) {
      issues.push({ file: filename, sheet, severity: 'error', message: `Could not read the Excel file: ${errMsg(e)}` });
      return result;
    }
    sheet = wb.SheetNames[0] || sheetName;
    const ws = wb.Sheets[wb.SheetNames[0]];
    if (!ws) {
      issues.push({ file: filename, sheet, severity: 'error', message: 'Workbook has no sheets' });
      return result;
    }
    const grid = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' }) as unknown[][];
    const acc = result.account;

    const headerIdx = grid.findIndex((r) => r.some((c) => cellText(c) === 'Fecha') && r.some((c) => cellText(c) === 'Referencia'));
    if (headerIdx < 0) {
      issues.push({ file: filename, sheet, severity: 'error', message: 'Could not find the Excel header row (Fecha, Referencia, …)' });
      return result;
    }

    // The .xls header block is a label row with the values on the NEXT row, in the same
    // columns (e.g. "Cuenta | ... | Moneda" above "Ca Total ..., 005200910615 | ... | USD").
    const knownKeys = new Set(['cliente', 'cuenta', 'numero', 'número', 'moneda', 'movimientos', 'sucursal', 'desde']);
    for (let i = 0; i < headerIdx; i++) {
      const r = grid[i].map((c) => cellText(c));
      const next = i + 1 < grid.length ? grid[i + 1].map((c) => cellText(c)) : [];
      for (let cIdx = 0; cIdx < r.length; cIdx++) {
        const key = r[cIdx].replace(/:$/, '').toLowerCase().trim();
        if (!knownKeys.has(key)) continue;
        let val = next[cIdx] || '';
        if (!val) {
          for (let j = cIdx + 1; j < r.length; j++) {
            if (r[j] && !knownKeys.has(r[j].replace(/:$/, '').toLowerCase().trim())) {
              val = r[j];
              break;
            }
          }
        }
        if (key === 'cliente') acc.holder = val;
        if (key === 'cuenta') {
          const m = val.match(/([0-9]{6,})/);
          const label = val.split(',')[0].trim();
          if (m) {
            acc.number = m[1];
            acc.id = `santander-${m[1]}`;
          }
          acc.name = `${label || 'Cuenta'} ${m ? m[1] : ''}`.trim();
        }
        if (key === 'numero' || key === 'número') {
          const m = val.match(/([0-9]{6,})/);
          if (m) {
            acc.number = m[1];
            acc.id = `santander-${m[1]}`;
          }
        }
        if (key === 'moneda') {
          if (/USD/i.test(val)) acc.currency = 'USD';
          else if (/UYU/i.test(val)) acc.currency = 'UYU';
        }
        if (key === 'movimientos') {
          const m = val.match(/(\d{2})\/(\d{2})\/(\d{4})\s*-\s*(\d{2})\/(\d{2})\/(\d{4})/);
          if (m) {
            acc.periodFrom = parseStatementDate(m.slice(1, 4).join('/')) ?? undefined;
            acc.periodTo = parseStatementDate(m.slice(4, 7).join('/')) ?? undefined;
          }
        }
      }
    }

    const header = grid[headerIdx].map((c) => cellText(c));
    const col = (name: string) => header.findIndex((h) => h.toLowerCase() === name.toLowerCase());
    const iDate = col('Fecha');
    const iRef = col('Referencia');
    const iTipo = col('Tipo Movimiento');
    const iDesc = col('Descripción');
    const iDebit = col('Débito');
    const iCredit = col('Crédito');
    const iSaldo = col('Saldo');
    const cell = (r: unknown[], i: number) => (i >= 0 && i < r.length ? cellText(r[i]) : '');

    for (let i = headerIdx + 1; i < grid.length; i++) {
      const r = grid[i];
      const date = cell(r, iDate);
      if (!date) continue;
      const tipo = cell(r, iTipo);
      const desc = cell(r, iDesc);
      rows.push({
        date,
        ref: cell(r, iRef),
        concepto: tipo,
        descripcion: desc,
        debit: cell(r, iDebit),
        credit: cell(r, iCredit),
        saldo: cell(r, iSaldo),
        rowNo: i + 1,
      });
    }
  }

  // ─── Map rows → RawTxn ───
  let lastSaldo: number | null = null;
  for (const row of rows) {
    const date = parseStatementDate(row.date);
    if (!date) {
      issues.push({ file: filename, sheet: 'rows', row: row.rowNo, field: 'Fecha', raw: row.date, severity: 'warning', message: 'Unparseable date — row skipped' });
      continue;
    }
    const debit = parseAmount(row.debit);
    const credit = parseAmount(row.credit);
    let amount: number;
    if (debit !== null && credit !== null && debit !== 0 && credit !== 0) {
      issues.push({ file: filename, sheet: 'rows', row: row.rowNo, field: 'Débito/Crédito', raw: `${row.debit} / ${row.credit}`, severity: 'warning', message: 'Row has both a debit and a credit — using the debit' });
      amount = debit;
    } else if (debit !== null && debit !== 0) {
      amount = debit; // stored negative
    } else if (credit !== null && credit !== 0) {
      amount = credit;
    } else {
      issues.push({ file: filename, sheet: 'rows', row: row.rowNo, field: 'Importe', raw: `${row.debit} / ${row.credit}`, severity: 'warning', message: 'No amount found — row skipped' });
      continue;
    }

    const description = [row.concepto, row.descripcion].filter(Boolean).join(' ').replace(/\s{2,}/g, ' ').trim();
    const saldo = parseAmount(row.saldo);
    if (saldo !== null) lastSaldo = saldo;

    const [kind, counterparty] = classifySantanderConcept(description, amount);
    result.transactions.push({
      accountId: result.account.id,
      date,
      description,
      amount,
      currency: result.account.currency,
      kind,
      reference: row.ref || undefined,
      counterparty,
      metadata: { raw: row },
    });
  }

  if (lastSaldo !== null) result.account.closingBalance = lastSaldo;
  if (result.transactions.length > 0) {
    const dates = result.transactions.map((t) => t.date);
    result.account.periodFrom = result.account.periodFrom ?? new Date(Math.min(...dates.map((d) => d.getTime())));
    result.account.periodTo = result.account.periodTo ?? new Date(Math.max(...dates.map((d) => d.getTime())));
  }
  return result;
}

/** Classify a Santander concepto/descripción into a semantic kind + counterparty. */
export function classifySantanderConcept(description: string, _amount: number): [RawTxnKind, string | undefined] {
  const upper = description.toUpperCase();
  if (/PCAMBIO/i.test(upper)) return ['fx', undefined];
  if (/CAMBIO|CAMBIA/i.test(upper)) return ['fx', undefined];
  if (/PAGO ELECTRONICO TARJETA|PAGO.*TARJETA CREDITO/i.test(upper)) return ['card-payment', 'Visa Santander'];
  if (/TARJETA CREDITO/i.test(upper)) return ['card-payment', 'Visa Santander'];
  if (/COBRO TARJETA|COMISION|COMISIÓN/i.test(upper)) return ['fee', undefined];
  if (/COMPRA CON TARJETA/i.test(upper)) return ['purchase', undefined];
  if (/TRANSFERENCIA RECIBIDA|TRANSF.*RECIBIDA|CREDITO OPERACION/i.test(upper)) {
    return ['transfer-in', extractName(upper)];
  }
  if (/TRANSFERENCIA ENVIADA|TRANSF.*ENVIADA|TRF\./i.test(upper)) {
    return ['transfer-out', extractName(upper)];
  }
  if (/DB\. PAGO|PAGO SUELDOS|DEBITO OPERACION/i.test(upper)) {
    if (/TRF\.|TRANSF/i.test(upper)) return ['transfer-out', extractName(upper)];
    return ['purchase', extractName(upper)];
  }
  return ['other', extractName(upper)];
}

/** Pull the trailing counterparty name out of a Santander description, if there is one. */
function extractName(upper: string): string | undefined {
  const m = upper.match(/(?:RECIBIDA|ENVIADA|TRF\. PLAZA|RECIBIDA|CREDITO OPERACION EN BANCA DIGITAL)\s+[^A-Z]*([A-Z][A-Z. ]{3,})/);
  if (m) {
    const name = m[1].trim().replace(/\s{2,}/g, ' ');
    return name.length > 2 ? name : undefined;
  }
  return undefined;
}

function cellText(v: unknown): string {
  if (v === null || v === undefined) return '';
  return String(v).trim();
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
