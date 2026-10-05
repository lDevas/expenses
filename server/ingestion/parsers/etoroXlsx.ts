import * as XLSX from 'xlsx';
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
 * eToro account statement (.xlsx). The file is a real zip-xlsx but uses a non-standard
 * "x:" XML namespace prefix that makes exceljs fail — SheetJS reads it fine, so we use that.
 *
 * Sheets: Account Summary, Holdings, Closed Positions, Account Activity, Dividends,
 * Financial Summary, Glossary.
 *
 * Quirks handled:
 *  - "Open Position" rows store a POSITIVE amount but are cash OUTFLOWS → negated.
 *  - Holdings snapshot dates are Excel serials (decode with 1899-12-30 epoch).
 *  - Activity dividends are already net of 30% US withholding; gross is reconstructed
 *    from the Dividends sheet (matched by position id + payment date).
 *  - Cross-check: Activity totals vs Financial Summary → warning on mismatch.
 */
export function parseEtoroXlsx(buffer: Buffer, filename: string): ParsedStatement {
  const issues: Issue[] = [];
  const result: ParsedStatement = {
    kind: 'etoro-statement',
    file: filename,
    account: {
      id: 'etoro-trading',
      institutionId: 'etoro',
      institutionName: 'eToro',
      name: 'eToro trading account',
      type: 'investment',
      currency: 'USD',
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
    issues.push({ file: filename, severity: 'error', message: `Could not read the workbook: ${errMsg(e)}` });
    return result;
  }

  const sheet = (name: string): unknown[][] | null => {
    const ws = wb.Sheets[name];
    if (!ws) return null;
    return XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' }) as unknown[][];
  };

  const acc = result.account;

  // ─── Account Summary (meta + summary values) ───
  const summaryRows = sheet('Account Summary');
  if (summaryRows) {
    for (const r of summaryRows) {
      const key = cellText(r[0]).replace(/\s+/g, ' ');
      const value = r[1];
      if (!key) continue;
      if (key === 'Name' && typeof value === 'string' && value) {
        if (acc.holder === undefined) acc.holder = cellText(value);
        continue;
      }
      if (key === 'Username' && cellText(value)) {
        acc.name = `eToro trading account (${cellText(value)})`;
        acc.number = cellText(value);
        continue;
      }
      if (key === 'Currency') {
        if (cellText(value)) acc.currency = cellText(value).toUpperCase();
        continue;
      }
      if (key === 'Start Date') {
        acc.periodFrom = parseStatementDate(cellText(value)) ?? undefined;
        continue;
      }
      if (key === 'End Date') {
        acc.periodTo = parseStatementDate(cellText(value)) ?? undefined;
        continue;
      }
      const n = parseAmount(value);
      if (n !== null) result.summary[key] = n;
    }
  } else {
    issues.push({ file: filename, sheet: 'Account Summary', severity: 'warning', message: 'Account Summary sheet not found' });
  }

  // ─── Build position-id → ticker map from Activity + Dividends ───
  const tickerById = new Map<string, string>();
  const activity = sheet('Account Activity');
  const dividends = sheet('Dividends');
  if (activity) {
    for (let i = 1; i < activity.length; i++) {
      const r = activity[i];
      const details = cellText(r[2]);
      const posId = cellText(r[8]);
      const t = details.match(/^([A-Za-z.]{1,10})\/[A-Z]{3}/);
      if (t && posId && posId !== '-') tickerById.set(posId, t[1].toUpperCase());
    }
  }

  // ─── Holdings → positions ───
  const holdings = sheet('Holdings');
  if (holdings) {
    for (let i = 1; i < holdings.length; i++) {
      const r = holdings[i];
      const snapshot = parseStatementDate(r[0]);
      if (!snapshot) {
        issues.push({ file: filename, sheet: 'Holdings', row: i + 1, field: 'Snapshot Date', raw: String(r[0]), severity: 'warning', message: 'Unparseable snapshot date — row skipped' });
        continue;
      }
      const asset = cellText(r[1]);
      const posId = cellText(r[2]);
      if (!asset) continue;
      const units = parseAmount(r[7]);
      const openRate = parseAmount(r[6]);
      const value = parseAmount(r[9]);
      const symbol = tickerById.get(posId) || asset;
      const p: ParsedPosition = {
        accountId: acc.id,
        symbol,
        name: asset,
        qty: units ?? 0,
        costBasis: openRate !== null && units !== null ? openRate * units : undefined,
        value: value ?? undefined,
        snapshotDate: snapshot,
        currency: acc.currency,
        metadata: { positionId: posId, direction: cellText(r[3]), openDate: cellText(r[4]), currentRate: cellText(r[8]), isin: cellText(r[11]) || undefined },
      };
      if (p.costBasis !== undefined && p.value !== undefined) p.unrealizedPl = p.value - p.costBasis;
      result.positions.push(p);
    }
  }

  // ─── Dividends sheet → gross/tax per position id ───
  const divGross = new Map<string, { net: number; tax: number; rate: string; name: string }>();
  if (dividends) {
    for (let i = 1; i < dividends.length; i++) {
      const r = dividends[i];
      const date = cellText(r[0]);
      const posId = cellText(r[10]);
      const net = parseAmount(r[2]);
      const tax = parseAmount(r[8]);
      const rate = cellText(r[7]);
      if (!date || net === null) continue;
      const key = `${date} | ${posId}`;
      divGross.set(key, { net, tax: tax ?? 0, rate, name: cellText(r[1]) });
    }
  }

  // ─── Account Activity → raw transactions ───
  if (activity) {
    for (let i = 1; i < activity.length; i++) {
      const r = activity[i];
      const dateRaw = cellText(r[0]);
      const type = cellText(r[1]);
      if (!type) continue;
      const date = parseStatementDate(dateRaw);
      if (!date) {
        issues.push({ file: filename, sheet: 'Account Activity', row: i + 1, field: 'Date', raw: dateRaw, severity: 'warning', message: 'Unparseable date — row skipped' });
        continue;
      }
      const details = cellText(r[2]);
      const stored = parseAmount(r[3]);
      const posId = cellText(r[8]);
      const balance = parseAmount(r[7]);

      let amount = stored ?? 0;
      let kind: RawTxn['kind'];
      const typeUpper = type.toUpperCase();
      if (/OPEN POSITION|CLOSE POSITION/.test(typeUpper)) {
        kind = 'trade';
        if (typeUpper.startsWith('OPEN')) amount = -Math.abs(amount); // stored positive but is a cash outflow
      } else if (/INTEREST/.test(typeUpper)) {
        kind = 'interest';
      } else if (/DIVIDEND/.test(typeUpper)) {
        kind = 'dividend';
      } else if (/SPLIT/.test(typeUpper)) {
        kind = 'split';
        amount = 0;
      } else if (/WITHDRAW/.test(typeUpper)) {
        kind = 'withdrawal';
      } else if (/DEPOSIT|TRANSFER (IN|TO TRADING)/.test(typeUpper)) {
        kind = 'deposit';
      } else if (/TRANSFER OUT/.test(typeUpper)) {
        kind = 'withdrawal';
      } else {
        kind = 'other';
      }

      const tickerMatch = details.match(/^([A-Za-z.]{1,10})\/([A-Z]{3})/);
      const symbol = tickerMatch ? tickerMatch[1].toUpperCase() : undefined;
      const currency = tickerMatch ? tickerMatch[2] : acc.currency;
      if (symbol) tickerById.set(posId || '', symbol);

      // reconstruct gross dividend from the Dividends sheet
      if (kind === 'dividend') {
        const payDate = dateRaw.slice(0, 10);
        const g = divGross.get(`${payDate} | ${posId}`) || divGross.get(`${payDate} | -`);
        if (g) {
          result.transactions.push({
            accountId: acc.id,
            date,
            description: `Dividend ${symbol || g.name}`,
            amount: g.net,
            currency,
            kind,
            counterparty: symbol,
            metadata: { symbol, gross: round2(g.net + g.tax), withholdingTax: round2(g.tax), taxRate: g.rate, positionId: posId || undefined, balanceAfter: balance ?? undefined },
          });
        } else {
          result.transactions.push({
            accountId: acc.id,
            date,
            description: `Dividend ${symbol || details}`,
            amount,
            currency,
            kind,
            counterparty: symbol,
            metadata: { symbol, positionId: posId || undefined, balanceAfter: balance ?? undefined, note: 'no matching Dividends-sheet row; gross unavailable' },
          });
        }
      } else {
        result.transactions.push({
          accountId: acc.id,
          date,
          description: typeUpper === 'OTHER' ? details || type : type + (details && details !== '-' ? ` ${details}` : ''),
          amount,
          currency,
          kind,
          counterparty: symbol,
          metadata: { type, details, positionId: posId || undefined, balanceAfter: balance ?? undefined },
        });
      }
    }
  }

  // ─── Closed Positions → realized ───
  const closed = sheet('Closed Positions');
  if (closed) {
    for (let i = 1; i < closed.length; i++) {
      const r = closed[i];
      const posId = cellText(r[0]);
      if (!posId) continue;
      const closeDate = parseStatementDate(cellText(r[6]));
      const pl = parseAmount(r[10]);
      if (!closeDate || pl === null) continue;
      const isin = cellText(r[21]);
      const realized: ParsedRealized = {
        accountId: acc.id,
        symbol: tickerById.get(posId) || (isin ? `(${isin})` : 'unknown'),
        name: undefined,
        date: closeDate,
        qty: parseAmount(r[4]) ?? undefined,
        proceeds: parseAmount(r[3]) ?? undefined,
        realizedPl: pl,
        currency: acc.currency,
        metadata: { positionId: posId, isin: isin || undefined, notes: cellText(r[22]) || undefined },
      };
      result.realized.push(realized);
    }
  }

  // ─── Cross-check: Activity totals vs Financial Summary ───
  const finSummary = sheet('Financial Summary');
  if (finSummary) {
    let fsInterest: number | null = null;
    let fsDividends: number | null = null;
    for (let i = 1; i < finSummary.length; i++) {
      const key = cellText(finSummary[i][0]).replace(/\s+/g, ' ');
      const n = parseAmount(finSummary[i][1]);
      if (n === null) continue;
      if (/TOTAL INTEREST/i.test(key)) fsInterest = n;
      if (/STOCK AND ETF DIVIDENDS/i.test(key)) fsDividends = n;
    }
    const actInterest = result.transactions.filter((t) => t.kind === 'interest').reduce((s, t) => s + t.amount, 0);
    const actDividends = result.transactions.filter((t) => t.kind === 'dividend').reduce((s, t) => s + t.amount, 0);
    if (fsInterest !== null && Math.abs(round2(actInterest) - fsInterest) > 0.01) {
      issues.push({ file: filename, sheet: 'Financial Summary', severity: 'warning', message: `Interest cross-check mismatch: Activity totals ${round2(actInterest)} but Financial Summary says ${fsInterest}` });
    }
    if (fsDividends !== null && Math.abs(round2(actDividends) - fsDividends) > 0.01) {
      issues.push({ file: filename, sheet: 'Financial Summary', severity: 'warning', message: `Dividends cross-check mismatch: Activity totals ${round2(actDividends)} but Financial Summary says ${fsDividends}` });
    }
  }

  return result;
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
