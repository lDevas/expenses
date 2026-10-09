import * as XLSX from 'xlsx';
import type { ParsedStatement, StatementKind } from '../types.ts';
import { parseItauEstado } from './itauEstadoXls.ts';
import { parseItauCardPdf } from './itauCardPdf.ts';
import { parseSantanderUmsatz } from './santanderUmsatz.ts';
import { parseSantanderCardXls } from './santanderCardXls.ts';
import { parseIbkrCsv } from './ibkrCsv.ts';
import { parseEtoroXlsx } from './etoroXlsx.ts';
import { parsePrexXlsx } from './prexXlsx.ts';

/**
 * Detect the statement type from the file name (and, where needed, a peek at the buffer).
 * Unknown files are routed by extension; genuinely unrecognizable files return null.
 */
export function detectStatementType(filename: string, buffer: Buffer): StatementKind | null {
  const name = filename.toLowerCase();
  const ext = name.split('.').pop() || '';

  if (name.includes('etoro')) return 'etoro-statement';
  if (name.includes('estado_de_cuenta') || name.includes('estado de cuenta')) return 'itau-estado';
  if (name.includes('prex')) return 'prex-estado'; // Prex exports and user-named copies
  if (name.startsWith('u1') && ext === 'csv') return 'ibkr-statement'; // IBKR account-number statements (U######)
  if (name.includes('umsatz')) return 'santander-umsatz';
  if (name.includes('creditcard')) return 'santander-card';
  if (name.startsWith('v_') && ext === 'pdf') return 'itau-card'; // Itau Visa iLink statements

  // Prex exports its statements as "estado_cuenta_…" (.xlsx, one word — Itau's
  // "estado_de_cuenta" is two words, so the two conventions do not collide).
  if (ext === 'xlsx' && name.includes('estado_cuenta')) return 'prex-estado';
  // Renamed Prex exports still carry the issuer in the document properties.
  if (ext === 'xlsx' && prexWorkbookCreator(buffer)) return 'prex-estado';

  // fallbacks by extension
  if (ext === 'xls' && name.includes('314')) return 'itau-estado';
  if (ext === 'pdf') return 'itau-card';
  return null;
}

/** Content peek: workbook document properties name prexcard.com as author/issuer. */
function prexWorkbookCreator(buffer: Buffer): boolean {
  try {
    const wb = XLSX.read(buffer, { type: 'buffer' });
    const fields = [wb.Props?.Author, wb.Props?.LastAuthor, wb.Props?.Company, wb.Props?.Title]
      .filter((v): v is string => typeof v === 'string')
      .join(' ').toLowerCase();
    return fields.includes('prex');
  } catch {
    return false;
  }
}

function makeUnknown(filename: string, reason: string): ParsedStatement {
  return {
    kind: 'unknown',
    file: filename,
    account: {
      id: 'unknown',
      institutionId: 'unknown',
      institutionName: 'Unknown',
      name: 'Unrecognized file',
      type: 'checking',
      currency: 'UYU',
    },
    transactions: [],
    positions: [],
    realized: [],
    summary: {},
    issues: [{ file: filename, severity: 'error', message: reason }],
  };
}

/**
 * Parse one uploaded statement file. Never throws: a file-level failure is
 * reported through the returned statements' issues array.
 *
 * A file can yield multiple statements: a multi-currency ledger (Prex) is split
 * into one statement per observed currency, all sharing the same file name.
 */
export async function parseStatements(filename: string, buffer: Buffer): Promise<ParsedStatement[]> {
  const kind = detectStatementType(filename, buffer);
  if (!kind) {
    return [makeUnknown(filename, `Unrecognized statement format: ${filename}. Supported: Itau estado (.xls), Itau Visa PDF, Santander umsatz (.xls/.csv), Santander Visa (.xls), IBKR CSV, eToro XLSX, Prex estado (.xlsx).`)];
  }

  try {
    switch (kind) {
      case 'itau-estado':
        return [parseItauEstado(buffer, filename)];
      case 'itau-card':
        return [await parseItauCardPdf(buffer, filename)];
      case 'santander-umsatz':
        return [parseSantanderUmsatz(buffer, filename)];
      case 'santander-card':
        return [parseSantanderCardXls(buffer, filename)];
      case 'ibkr-statement':
        return [parseIbkrCsv(buffer, filename)];
      case 'etoro-statement':
        return [parseEtoroXlsx(buffer, filename)];
      case 'prex-estado':
        return parsePrexXlsx(buffer, filename);
      case 'unknown':
        return [makeUnknown(filename, `Unrecognized statement format: ${filename}`)];
    }
  } catch (e) {
    // last-resort guard: parsers are written not to throw, but if one does, contain it
    return [{
      kind,
      file: filename,
      account: { id: 'unknown', institutionId: 'unknown', institutionName: 'Unknown', name: 'Unparsed', type: 'checking', currency: 'UYU' },
      transactions: [],
      positions: [],
      realized: [],
      summary: {},
      issues: [{ file: filename, severity: 'error', message: `Parser failed unexpectedly: ${e instanceof Error ? e.message : String(e)}` }],
    }];
  }
}

export { parseItauEstado, parseItauCardPdf, parseSantanderUmsatz, parseSantanderCardXls, parseIbkrCsv, parseEtoroXlsx, parsePrexXlsx };
