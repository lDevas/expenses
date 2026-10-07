import type { ParsedStatement, StatementKind } from '../types.ts';
import { parseItauEstado } from './itauEstadoXls.ts';
import { parseItauCardPdf } from './itauCardPdf.ts';
import { parseSantanderUmsatz } from './santanderUmsatz.ts';
import { parseSantanderCardXls } from './santanderCardXls.ts';
import { parseIbkrCsv } from './ibkrCsv.ts';
import { parseEtoroXlsx } from './etoroXlsx.ts';

/**
 * Detect the statement type from the file name (and, where needed, a peek at the buffer).
 * Unknown files are routed by extension; genuinely unrecognizable files return null.
 */
export function detectStatementType(filename: string, _buffer: Buffer): StatementKind | null {
  const name = filename.toLowerCase();
  const ext = name.split('.').pop() || '';

  if (name.includes('etoro')) return 'etoro-statement';
  if (name.includes('estado_de_cuenta') || name.includes('estado de cuenta')) return 'itau-estado';
  if (name.startsWith('u1') && ext === 'csv') return 'ibkr-statement'; // IBKR account-number statements (U######)
  if (name.includes('umsatz')) return 'santander-umsatz';
  if (name.includes('creditcard')) return 'santander-card';
  if (name.startsWith('v_') && ext === 'pdf') return 'itau-card'; // Itau Visa iLink statements

  // fallbacks by extension
  if (ext === 'xls' && name.includes('314')) return 'itau-estado';
  if (ext === 'pdf') return 'itau-card';
  return null;
}

/**
 * Parse one uploaded statement file. Never throws: a file-level failure is
 * reported through the returned ParsedStatement's issues array.
 */
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

export async function parseStatement(filename: string, buffer: Buffer): Promise<ParsedStatement> {
  const kind = detectStatementType(filename, buffer);
  if (!kind) {
    return makeUnknown(filename, `Unrecognized statement format: ${filename}. Supported: Itau estado (.xls), Itau Visa PDF, Santander umsatz (.xls/.csv), Santander Visa (.xls), IBKR CSV, eToro XLSX.`);
  }

  try {
    switch (kind) {
      case 'itau-estado':
        return parseItauEstado(buffer, filename);
      case 'itau-card':
        return await parseItauCardPdf(buffer, filename);
      case 'santander-umsatz':
        return parseSantanderUmsatz(buffer, filename);
      case 'santander-card':
        return parseSantanderCardXls(buffer, filename);
      case 'ibkr-statement':
        return parseIbkrCsv(buffer, filename);
      case 'etoro-statement':
        return parseEtoroXlsx(buffer, filename);
      case 'unknown':
        return makeUnknown(filename, `Unrecognized statement format: ${filename}`);
    }
  } catch (e) {
    // last-resort guard: parsers are written not to throw, but if one does, contain it
    return {
      kind,
      file: filename,
      account: { id: 'unknown', institutionId: 'unknown', institutionName: 'Unknown', name: 'Unparsed', type: 'checking', currency: 'UYU' },
      transactions: [],
      positions: [],
      realized: [],
      summary: {},
      issues: [{ file: filename, severity: 'error', message: `Parser failed unexpectedly: ${e instanceof Error ? e.message : String(e)}` }],
    };
  }
}

export { parseItauEstado, parseItauCardPdf, parseSantanderUmsatz, parseSantanderCardXls, parseIbkrCsv, parseEtoroXlsx };
