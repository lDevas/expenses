import { PDFParse } from 'pdf-parse';
import {
  parseAmount,
  parseStatementDate,
  type Issue,
  type ParsedStatement,
} from '../types.ts';

/**
 * Itau Visa iLink credit card statement (PDF, ~3 pages).
 *
 * Line layouts (from the extracted text):
 *   purchase : `DD MM YY 3002 MERCHANT [pesos] [dollars]`
 *   payment  : `DD MM YY PAGOS [-pesos] [-dollars]`
 *
 * Currency resolution per row (the statement carries up to two amount columns):
 *   - one amount              → UYU purchase (pesos column)
 *   - two amounts, equal      → USD purchase (merchant billed in USD; both columns hold USD)
 *   - two amounts, different  → foreign-currency purchase (e.g. ARS). The first column is the
 *                               original foreign amount; the second column is the USD the bank
 *                               bills. Per the owner we ignore the foreign currency and report
 *                               the account's currency (USD) — i.e. the second amount.
 * In every two-amount case the right-most column is the USD the card bills, so we use it.
 * `PAGOS` lines are payments into the card (negative on the statement); one raw txn per currency.
 * `REDUC. IVA LEY 17934` lines are tax credits, netted against their purchase by consolidation.
 */
export async function parseItauCardPdf(buffer: Buffer, filename: string): Promise<ParsedStatement> {
  const issues: Issue[] = [];
  const result: ParsedStatement = {
    kind: 'itau-card',
    file: filename,
    account: {
      id: 'itau-card-unknown',
      institutionId: 'itau-uy',
      institutionName: 'Itau Uruguay',
      name: 'Itau Visa iLink',
      type: 'credit',
      currency: 'UYU',
    },
    transactions: [],
    positions: [],
    realized: [],
    summary: {},
    issues,
  };

  let text: string;
  try {
    const parser = new PDFParse({ data: buffer });
    const res = await parser.getText();
    parser.destroy();
    text = res.text;
  } catch (e) {
    issues.push({ file: filename, severity: 'error', message: `Could not extract text from the PDF: ${errMsg(e)}` });
    return result;
  }

  const acc = result.account;
  const lines = text.split('\n').map((l) => l.trim());
  let matched = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;

    // header block → account meta
    if (acc.number === undefined) {
      const m = line.match(/\*(\d{6,})\*/) || line.match(/^(\d{6,})-\d+\s+\$/);
      if (m) {
        acc.number = m[1];
        acc.id = `itau-card-${m[1]}`;
        const limit = line.match(/\$\s*([\d.]+,\d{2})/);
        if (limit) acc.name = `Visa iLink *${acc.number}* (límite ${limit[1]} UYU)`;
      }
    }
    if (!acc.holder && i < 8 && line.match(/^[A-ZÑ][A-ZÑ .]{8,}$/)) {
      acc.holder = line;
    }

    // purchase / payment lines
    const dateParts = line.match(/^(\d{2})\s+(\d{2})\s+(\d{2})\s+/);
    if (!dateParts) continue;
    const rest = line.slice(dateParts[0].length);

    const twoAmounts = rest.match(/^(.+?)\s+(-?[\d.]+,\d{2})\s+(-?[\d.]+,\d{2})\s*$/);
    const oneAmount = twoAmounts ? null : rest.match(/^(.+?)\s+(-?[\d.]+,\d{2})\s*$/);
    if (!twoAmounts && !oneAmount) continue;

    const isPagos = /^\s*PAGOS\b/i.test(rest);
    const is3002 = /^\s*3002\b/.test(rest);
    if (!isPagos && !is3002) continue;

    const date = parseStatementDate(`${dateParts[1]}/${dateParts[2]}/${dateParts[3]}`);
    if (!date) {
      issues.push({ file: filename, row: i + 1, field: 'Fecha', raw: line, severity: 'warning', message: 'Unparseable date — line skipped' });
      continue;
    }

    let merchant: string;
    let a1: number | null;
    let a2: number | null;
    if (twoAmounts) {
      merchant = cleanMerchant(twoAmounts[1].replace(/^3002\s*/, ''));
      a1 = parseAmount(twoAmounts[2]);
      a2 = parseAmount(twoAmounts[3]);
    } else {
      merchant = cleanMerchant(oneAmount![1].replace(/^3002\s*/, ''));
      a1 = parseAmount(oneAmount![2]);
      a2 = null;
    }
    if (a1 === null) {
      issues.push({ file: filename, row: i + 1, field: 'Importe', raw: line, severity: 'warning', message: 'Could not parse amount — line skipped' });
      continue;
    }
    if (isPagos && a2 !== null && a2 !== 0) {
      issues.push({ file: filename, row: i + 1, field: 'Importe', raw: line, severity: 'info', message: 'Dual-currency payment split into UYU + USD rows' });
    }

    const merchantUpper = merchant.toUpperCase();
    const isReduc = merchantUpper.includes('REDUC. IVA');

    if (isPagos) {
      const pushSide = (amount: number, currency: string, note: string) => {
        result.transactions.push({
          accountId: acc.id,
          date,
          description: `Pago tarjeta (PAGOS) *${acc.number ?? ''}`,
          amount,
          currency,
          kind: 'card-payment',
          counterparty: `Itau Visa iLink *${acc.number ?? ''}`,
          metadata: { side: note, rawLine: line },
        });
        matched++;
      };
      if (a1 !== null && a1 !== 0) pushSide(a1, 'UYU', 'pesos');
      if (a2 !== null && a2 !== 0) pushSide(a2, 'USD', 'dollars');
    } else {
      let amount: number;
      let currency: string;
      const meta: Record<string, unknown> = { rawLine: line };
      if (a2 !== null && a2 !== 0) {
        // Two amount columns: the right-most is the USD the card bills. The left column is the
        // original currency — equal ⇒ merchant billed in USD; different ⇒ a foreign currency
        // (e.g. ARS). In both cases report the USD amount and ignore the foreign currency.
        amount = a2;
        currency = 'USD';
        meta.original = a1;
        meta.usd = a2;
      } else {
        // Single amount: a pesos (UYU) charge.
        amount = a1;
        currency = 'UYU';
        meta.uyu = a1;
      }
      // statement sign: + = charge (debt up), - = credit (debt down). Keep statement sign;
      // consolidation flips charges into negative expense items.
      result.transactions.push({
        accountId: acc.id,
        date,
        description: merchant,
        amount,
        currency,
        kind: isReduc ? 'refund' : 'purchase',
        metadata: meta,
      });
      matched++;
    }
  }

  if (matched === 0) {
    issues.push({ file: filename, severity: 'warning', message: 'No transaction lines matched — check the PDF layout' });
  } else {
    const dates = result.transactions.map((t) => t.date);
    acc.periodFrom = new Date(Math.min(...dates.map((d) => d.getTime())));
    acc.periodTo = new Date(Math.max(...dates.map((d) => d.getTime())));
    const netPesos = result.transactions.filter((t) => t.currency === 'UYU').reduce((s, t) => s + t.amount, 0);
    const netDollars = result.transactions.filter((t) => t.currency === 'USD').reduce((s, t) => s + t.amount, 0);
    result.summary['card net UYU'] = round2(netPesos);
    result.summary['card net USD'] = round2(netDollars);
  }

  if (!acc.name.includes('458553') && acc.number) {
    acc.name = `Visa iLink *${acc.number}*`;
  }
  return result;
}

function cleanMerchant(s: string): string {
  return s.replace(/\s{2,}/g, ' ').trim();
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
