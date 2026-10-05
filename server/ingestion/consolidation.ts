import type {
  ConsolidatedCategory,
  ConsolidatedExchange,
  ConsolidatedItem,
  ConsolidatedPosition,
  ConsolidatedRealized,
  ConsolidatedResult,
  Issue,
  ParsedStatement,
} from './types.ts';
import { generateId, toISODate, withinDays } from './types.ts';
import { AccountRegistry, BROKER_WIRE_KEYWORDS, isOwnAccountNumber, type RegistryAccount } from './registry.ts';
import type { CtxTxn } from './consolidation/pairing.ts';
import { ctxOf, findPair, consumePair } from './consolidation/pairing.ts';

/**
 * The consolidation engine. Pure function over all parsed statements, driven by the
 * account registry. Produces the five output lists + the issue log.
 *
 * Broker semantics ("not expenses" rule):
 *  1. cash-boundary events (deposits/withdrawals) -> transfers list, hidden from items
 *  2. in-broker movements (trades, splits)        -> positions + realized only
 *  3. true cash income (dividends, interest)      -> items (investment-income / tax)
 */
export function consolidate(statements: ParsedStatement[]): ConsolidatedResult {
  const registry = AccountRegistry.from(statements);
  const issues: Issue[] = [];
  for (const s of statements) issues.push(...s.issues);

  // ─── Flatten transactions with context ───
  const all: CtxTxn[] = [];
  for (const s of statements) {
    const account = registry.get(s.account.id) ?? registryAccountOf(s);
    for (const t of s.transactions) all.push(ctxOf(s, account, t));
  }

  const result: ConsolidatedResult = {
    runId: generateId(),
    generatedAt: new Date(),
    files: statements.map((s) => s.file),
    items: [],
    transfers: [],
    exchanges: [],
    positions: [],
    realized: [],
    issues,
  };

  stepFx(result, all);
  stepCardPayments(result, all);
  stepInternalTransfers(result, all);
  stepBroker(result, all);
  stepReimbursements(result, all);
  stepItems(result, all);
  stepPositions(result, statements, registry);
  stepRealized(result, statements, registry);

  result.items.sort((a, b) => a.date.getTime() - b.date.getTime() || a.accountLabel.localeCompare(b.accountLabel));
  return result;
}

function registryAccountOf(s: ParsedStatement): RegistryAccount {
  return {
    id: s.account.id,
    institutionId: s.account.institutionId,
    institutionName: s.account.institutionName,
    type: s.account.type,
    currencies: [s.account.currency],
    isCard: s.account.type === 'credit',
    number: s.account.number,
    label: s.account.name,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function sign(n: number): number {
  return n > 0 ? 1 : n < 0 ? -1 : 0;
}

function dedup(list: string[]): string[] {
  return [...new Set(list)];
}

function sameAccountNumber(a: string, b: string): boolean {
  const na = a.replace(/[^\d]/g, '');
  const nb = b.replace(/[^\d]/g, '');
  return na.length > 3 && na === nb;
}

function absDaysBetween(a: Date, b: Date): number {
  const da = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
  const db = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.abs(Math.round((db - da) / 86400000));
}

/**
 * Emit an item from one side of a pairing (or a standalone row).
 * Credit-card charges are stored positive on the statement; flip them so items are
 * signed by cash effect (expense negative). `card-payment` items keep statement sign.
 */
function pushItem(result: ConsolidatedResult, a: CtxTxn, partner: CtxTxn | null | undefined, category: ConsolidatedCategory, extraMetadata?: Record<string, unknown>): void {
  const keepStatementSign = category === 'card-payment';
  const amount = round2(keepStatementSign ? a.txn.amount : a.account.isCard ? -a.txn.amount : a.txn.amount);
  const metadata: Record<string, unknown> = { ...(a.txn.metadata ?? {}), ...(extraMetadata ?? {}) };
  if (partner) {
    metadata.pairedWith = { file: partner.file, description: partner.txn.description, amount: partner.txn.amount, date: toISODate(partner.txn.date) };
  }
  const item: ConsolidatedItem = {
    id: generateId(),
    accountId: a.account.id,
    accountLabel: a.account.label,
    date: a.txn.date,
    description: a.txn.description,
    amount,
    currency: a.txn.currency,
    category,
    reference: a.txn.reference,
    metadata,
    sourceFiles: dedup(partner ? [a.file, partner.file] : [a.file]),
  };
  result.items.push(item);
}

// ─── Step 1: FX exchanges (own-account currency swaps) ───

function stepFx(result: ConsolidatedResult, all: CtxTxn[]): void {
  for (const a of all) {
    if (a.txn.kind !== 'fx' || a.consumed) continue;
    const b = findFxPartner(a, all);
    if (b) {
      consumePair(a, b);
      result.exchanges.push(makeExchangePair(a, b));
    } else {
      a.consumed = true;
      result.exchanges.push(makeExchangeSingle(a));
    }
  }
}

function findFxPartner(a: CtxTxn, all: CtxTxn[]): CtxTxn | null {
  let best: CtxTxn | null = null;
  let bestDelta = Infinity;
  for (const b of all) {
    if (b === a || b.consumed || b.txn.kind !== 'fx') continue;
    if (b.account.id === a.account.id) continue;
    if (b.account.institutionId !== a.account.institutionId) continue;
    if (b.txn.currency === a.txn.currency) continue;
    if (a.txn.amount === 0 || sign(b.txn.amount) !== -sign(a.txn.amount)) continue;
    if (!withinDays(a.txn.date, b.txn.date, 1)) continue;
    if (a.txn.reference && b.txn.reference && a.txn.reference !== b.txn.reference) continue;
    if (!(a.txn.reference && b.txn.reference)) {
      const linksAB = a.txn.counterparty !== undefined && a.account.number !== undefined && b.account.number !== undefined && sameAccountNumber(a.txn.counterparty, b.account.number);
      const linksBA = b.txn.counterparty !== undefined && a.account.number !== undefined && b.account.number !== undefined && sameAccountNumber(b.txn.counterparty, a.account.number);
      if (!linksAB && !linksBA) continue;
    }
    const delta = absDaysBetween(a.txn.date, b.txn.date);
    if (delta < bestDelta) {
      best = b;
      bestDelta = delta;
    }
  }
  return best;
}

/** from = the debited (sold) side, to = the credited (bought) side. Rate = to per 1 from. */
function makeExchangePair(a: CtxTxn, b: CtxTxn): ConsolidatedExchange {
  const from = a.txn.amount < 0 ? a : b;
  const to = from === a ? b : a;
  const fromAmt = Math.abs(from.txn.amount);
  const toAmt = Math.abs(to.txn.amount);
  const impliedRate = fromAmt > 0 && from.txn.currency !== to.txn.currency ? round2(toAmt / fromAmt) : undefined;
  return {
    id: generateId(),
    matchStatus: 'matched',
    accountId: from.account.id,
    accountLabel: `${from.account.label} ↔ ${to.account.label}`,
    date: from.txn.date,
    description: `Currency exchange: ${from.txn.description} ↔ ${to.txn.description}`,
    fromCurrency: from.txn.currency,
    fromAmount: round2(fromAmt),
    toCurrency: to.txn.currency,
    toAmount: round2(toAmt),
    impliedRate,
    sourceFiles: dedup([a.file, b.file]),
  };
}

function makeExchangeSingle(a: CtxTxn): ConsolidatedExchange {
  return {
    id: generateId(),
    matchStatus: 'unmatched',
    accountId: a.account.id,
    accountLabel: a.account.label,
    date: a.txn.date,
    description: a.txn.description,
    fromCurrency: a.txn.currency,
    fromAmount: round2(Math.abs(a.txn.amount)),
    impliedRate: undefined,
    sourceFiles: [a.file],
  };
}

// ─── Step 2: Card payments (paying account ↔ card account) ───

function stepCardPayments(result: ConsolidatedResult, all: CtxTxn[]): void {
  const payers = all.filter((t) => !t.consumed && t.txn.kind === 'card-payment' && !t.account.isCard);
  const cardSide = all.filter((t) => t.txn.kind === 'card-payment' && t.account.isCard);
  for (const a of payers) {
    if (a.consumed) continue;
    const b = findPair(a, cardSide, { windowDays: 3, tolerance: 0.01 });
    if (!b) continue;
    consumePair(a, b);
    result.transfers.push({
      id: generateId(),
      kind: 'card',
      matchStatus: 'matched',
      fromAccountId: a.account.id,
      fromAccountLabel: a.account.label,
      fromCurrency: a.txn.currency,
      fromAmount: round2(Math.abs(a.txn.amount)),
      fromDate: a.txn.date,
      fromDescription: a.txn.description,
      toAccountId: b.account.id,
      toAccountLabel: b.account.label,
      toCurrency: b.txn.currency,
      toAmount: round2(Math.abs(b.txn.amount)),
      toDate: b.txn.date,
      toDescription: b.txn.description,
      sourceFiles: dedup([a.file, b.file]),
    });
  }
}

// ─── Step 3: Internal transfers (own-account rows, never expenses) ───

function stepInternalTransfers(result: ConsolidatedResult, all: CtxTxn[]): void {
  for (const a of all) {
    if (a.consumed) continue;
    if (a.txn.kind !== 'transfer-in' && a.txn.kind !== 'transfer-out') continue;
    if (!isOwnAccountNumber(a.txn.counterparty)) continue;

    let partner: CtxTxn | null = null;
    for (const b of all) {
      if (b === a || b.consumed) continue;
      if (b.account.id === a.account.id) continue;
      if (b.account.institutionId !== a.account.institutionId) continue;
      if (b.txn.kind !== 'transfer-in' && b.txn.kind !== 'transfer-out') continue;
      if (a.txn.amount === 0 || sign(b.txn.amount) !== -sign(a.txn.amount)) continue;
      if (Math.abs(Math.abs(a.txn.amount) - Math.abs(b.txn.amount)) > 0.01) continue;
      if (!withinDays(a.txn.date, b.txn.date, 1)) continue;
      if (!a.txn.counterparty || !b.account.number || !sameAccountNumber(a.txn.counterparty, b.account.number)) continue;
      partner = b;
      break;
    }

    if (partner) consumePair(a, partner);
    else a.consumed = true;

    // one item from the debit side when both sides exist, otherwise from the row itself
    const source = a.txn.amount < 0 ? a : partner && partner.txn.amount < 0 ? partner : a;
    pushItem(result, source, partner ?? undefined, 'internal-transfer');
  }
}

// ─── Step 4: Broker accounts (wires, dividends, interest, trades) ───

function stepBroker(result: ConsolidatedResult, all: CtxTxn[]): void {
  const brokerTxns = all.filter((t) => t.account.type === 'investment');
  const bankTxns = all.filter((t) => t.account.type !== 'investment');

  // implied UYU/USD rates from the matched FX pairs (period rate pool)
  const rates: { date: Date; rate: number }[] = result.exchanges
    .filter((e) => e.matchStatus === 'matched' && e.impliedRate !== undefined && e.fromAmount !== undefined && e.toAmount !== undefined && e.fromAmount > 0)
    .map((e) => ({ date: e.date ?? new Date(), rate: e.impliedRate! }));

  // 1. cash-boundary events → transfers list (always hidden from items)
  for (const a of brokerTxns) {
    if (a.consumed) continue;
    if (a.txn.kind !== 'deposit' && a.txn.kind !== 'withdrawal') continue;
    const b = findWirePartner(a, bankTxns, rates);
    consumePair(a, b);
    const brokerIsFrom = a.txn.amount < 0; // withdrawal: money leaves the broker
    result.transfers.push({
      id: generateId(),
      kind: 'wire',
      matchStatus: b ? 'matched' : 'unmatched',
      fromAccountId: brokerIsFrom ? a.account.id : b?.account.id,
      fromAccountLabel: brokerIsFrom ? a.account.label : b ? b.account.label : a.account.label,
      fromCurrency: brokerIsFrom ? a.txn.currency : b?.txn.currency,
      fromAmount: round2(Math.abs(brokerIsFrom ? a.txn.amount : (b?.txn.amount ?? 0))),
      fromDate: brokerIsFrom ? a.txn.date : b?.txn.date,
      fromDescription: brokerIsFrom ? a.txn.description : b?.txn.description,
      toAccountId: brokerIsFrom ? b?.account.id : a.account.id,
      toAccountLabel: brokerIsFrom ? (b ? b.account.label : a.account.label) : a.account.label,
      toCurrency: brokerIsFrom ? b?.txn.currency : a.txn.currency,
      toAmount: round2(Math.abs(brokerIsFrom ? (b?.txn.amount ?? 0) : a.txn.amount)),
      toDate: brokerIsFrom ? b?.txn.date : a.txn.date,
      toDescription: brokerIsFrom ? b?.txn.description : a.txn.description,
      impliedRate: b && a.txn.currency !== b.txn.currency && Math.abs(a.txn.amount) > 0 ? round2(Math.abs(b.txn.amount) / Math.abs(a.txn.amount)) : undefined,
      sourceFiles: dedup(b ? [a.file, b.file] : [a.file]),
    });
    if (!b) {
      result.issues.push({ file: a.file, severity: 'info', message: `Broker ${a.txn.kind} of ${a.txn.currency} ${round2(Math.abs(a.txn.amount))} on ${toISODate(a.txn.date)} has no matching bank row in this batch (expected when the bank file for that month is not provided)` });
    }
  }

  // 2. dividends ↔ withholding → one net item per (date, symbol).
  // IBKR style: gross dividend rows + separate withholding rows, paired by (date, symbol).
  // eToro style: amounts already net, gross/tax carried in the row metadata → one item per row.
  const dividends = brokerTxns.filter((t) => !t.consumed && t.txn.kind === 'dividend');
  const withholds = brokerTxns.filter((t) => !t.consumed && t.txn.kind === 'withholding');
  const divKey = (t: CtxTxn) => `${toISODate(t.txn.date)}|${t.txn.counterparty ?? ''}`;
  const whGroups = new Map<string, CtxTxn[]>();
  for (const w of withholds) {
    const g = whGroups.get(divKey(w));
    if (g) g.push(w);
    else whGroups.set(divKey(w), [w]);
  }
  const groupedDivs = new Map<string, CtxTxn[]>();
  for (const d of dividends) {
    if (d.consumed) continue;
    const key = divKey(d);
    if (whGroups.has(key)) {
      const g = groupedDivs.get(key);
      if (g) g.push(d);
      else groupedDivs.set(key, [d]);
    } else {
      // net dividend with tax in metadata (eToro)
      consumePair(d, null);
      const meta = (d.txn.metadata ?? {}) as Record<string, unknown>;
      pushItem(result, d, null, 'investment-income', {
        symbol: d.txn.counterparty ?? (meta.symbol as string) ?? undefined,
        gross: (meta.gross as number) ?? round2(d.txn.amount),
        withholdingTax: (meta.withholdingTax as number) ?? 0,
      });
    }
  }
  for (const [key, group] of groupedDivs) {
    const taxGroup = whGroups.get(key) ?? [];
    for (const t of [...group, ...taxGroup]) t.consumed = true;
    const first = group[0];
    const gross = round2(group.reduce((s, d) => s + d.txn.amount, 0));
    const tax = round2(-taxGroup.reduce((s, w) => s + w.txn.amount, 0));
    const symbol = first.txn.counterparty ?? '';
    result.items.push({
      id: generateId(),
      accountId: first.account.id,
      accountLabel: first.account.label,
      date: first.txn.date,
      description: `Dividend ${symbol} (net of US withholding)`.trim(),
      amount: round2(gross - tax),
      currency: first.txn.currency,
      category: 'investment-income',
      reference: symbol || undefined,
      metadata: { symbol: first.txn.counterparty, gross, withholdingTax: tax, dividendRows: group.length },
      sourceFiles: dedup([...group, ...taxGroup].map((t) => t.file)),
    });
  }
  // leftover withholds (no dividend group took them) → tax items
  for (const w of withholds) {
    if (w.consumed) continue;
    w.consumed = true;
    pushItem(result, w, null, 'tax', { symbol: w.txn.counterparty, ...(w.txn.metadata ?? {}) });
  }

  // 3. interest → investment income
  for (const a of brokerTxns) {
    if (a.consumed) continue;
    if (a.txn.kind !== 'interest') continue;
    consumePair(a, null);
    pushItem(result, a, null, 'investment-income', { ...(a.txn.metadata ?? {}) });
  }

  // 4. in-broker movements: trades + splits are never items
  for (const a of brokerTxns) {
    if (a.consumed) continue;
    if (a.txn.kind !== 'trade' && a.txn.kind !== 'split') continue;
    a.consumed = true;
  }

  // 5. broker fees → fee items
  for (const a of brokerTxns) {
    if (a.consumed) continue;
    if (a.txn.kind !== 'fee') continue;
    consumePair(a, null);
    pushItem(result, a, null, 'fee', { ...(a.txn.metadata ?? {}) });
  }
}

/**
 * Cross-boundary wire pairing: broker deposit/withdrawal ↔ bank debit/credit.
 * Counterparty keywords on the bank side, opposite sign, ±2 days, and amount
 * (exact if same currency, else ±3% against the period implied UYU/USD rate).
 */
function findWirePartner(a: CtxTxn, bankTxns: CtxTxn[], rates: { date: Date; rate: number }[]): CtxTxn | null {
  let best: CtxTxn | null = null;
  let bestScore = Infinity;
  for (const b of bankTxns) {
    if (b.consumed) continue;
    const desc = `${b.txn.description} ${b.txn.counterparty ?? ''}`.toUpperCase();
    if (!BROKER_WIRE_KEYWORDS.some((k) => desc.includes(k))) continue;
    if (a.txn.amount === 0 || sign(b.txn.amount) !== -sign(a.txn.amount)) continue;
    if (!withinDays(a.txn.date, b.txn.date, 2)) continue;
    const magA = Math.abs(a.txn.amount);
    const magB = Math.abs(b.txn.amount);
    if (a.txn.currency === b.txn.currency) {
      if (Math.abs(magA - magB) > 1) continue; // same currency: near-exact
    } else {
      const rate = closestRate(rates, a.txn.date);
      if (!rate) continue;
      const expected = magA * rate;
      if (Math.abs(magB - expected) > 0.03 * expected) continue; // ±3%
    }
    const score = absDaysBetween(a.txn.date, b.txn.date);
    if (score < bestScore) {
      best = b;
      bestScore = score;
    }
  }
  return best;
}

/** Closest pooled FX rate by date (falls back to the mean of the pool). */
function closestRate(rates: { date: Date; rate: number }[], on: Date): number | null {
  if (rates.length === 0) return null;
  let best = rates[0];
  let bestDelta = Infinity;
  for (const r of rates) {
    const d = absDaysBetween(r.date, on);
    if (d < bestDelta) {
      best = r;
      bestDelta = d;
    }
  }
  if (bestDelta > 90) return rates.reduce((s, r) => s + r.rate, 0) / rates.length;
  return best.rate;
}

// ─── Step 5: Reimbursement condense (REDIVA / REDUC. IVA ↔ purchase) ───

function stepReimbursements(result: ConsolidatedResult, all: CtxTxn[]): void {
  for (const a of all) {
    if (a.consumed || a.txn.kind !== 'refund') continue;

    let partner: CtxTxn | null = null;

    // Itau estado: "REDIVA 19210<ref>" matches the purchase carrying <ref>
    const m = a.txn.description.match(/REDIVA\s*19210\s*(\S+)/i);
    if (m) {
      const token = m[1].toUpperCase();
      for (const b of all) {
        if (b === a || b.consumed) continue;
        if (b.account.id !== a.account.id) continue;
        if (!withinDays(a.txn.date, b.txn.date, 1)) continue;
        if (b.txn.kind !== 'purchase' && b.txn.kind !== 'other') continue;
        if (b.txn.description.toUpperCase().includes(token)) {
          partner = b;
          break;
        }
      }
    }

    // Itau PDF: "REDUC. IVA" nets against the purchase that immediately precedes it
    if (!partner && /REDUC\.? ?IVA/i.test(a.txn.description)) {
      const idx = all.indexOf(a);
      for (let i = idx - 1; i >= 0; i--) {
        const b = all[i];
        if (b.consumed || b.account.id !== a.account.id) continue;
        if (b.txn.kind !== 'purchase' || b.txn.amount <= 0) continue;
        if (!withinDays(a.txn.date, b.txn.date, 0)) continue;
        partner = b;
        break;
      }
    }

    if (!partner) continue; // unnetted refund falls through to stepItems as income

    consumePair(a, partner);
    // algebraic sum of the two statement signs; card rows flip to a negative expense
    const combined = partner.txn.amount + a.txn.amount;
    const amount = round2(a.account.isCard ? -combined : combined);
    result.items.push({
      id: generateId(),
      accountId: partner.account.id,
      accountLabel: partner.account.label,
      date: partner.txn.date,
      description: partner.txn.description,
      amount,
      currency: partner.txn.currency,
      category: 'expense',
      reference: partner.txn.reference,
      metadata: { ...((partner.txn.metadata ?? {}) as Record<string, unknown>), refund: round2(Math.abs(a.txn.amount)), refundDescription: a.txn.description },
      sourceFiles: dedup([a.file, partner.file]),
    });
  }
}

// ─── Step 6: Everything left over → items ───

function stepItems(result: ConsolidatedResult, all: CtxTxn[]): void {
  for (const a of all) {
    if (a.consumed) continue;
    const { category, skip } = categorize(a);
    a.consumed = true;
    if (skip) continue;
    pushItem(result, a, null, category);
  }
}

function categorize(a: CtxTxn): { category: ConsolidatedCategory; skip: boolean } {
  switch (a.txn.kind) {
    case 'purchase':
      return { category: 'expense', skip: false };
    case 'refund':
      return { category: 'income', skip: false };
    case 'transfer-in':
      return { category: 'transfer-in', skip: false };
    case 'transfer-out':
      return { category: 'transfer-out', skip: false };
    case 'fx':
      return { category: 'fx-exchange', skip: false };
    case 'fee':
      return { category: 'fee', skip: false };
    case 'interest':
      return { category: 'investment-income', skip: false };
    case 'dividend':
      return { category: 'investment-income', skip: false };
    case 'withholding':
      return { category: 'tax', skip: false };
    case 'card-payment':
      return { category: 'card-payment', skip: false };
    case 'deposit':
      return { category: 'transfer-in', skip: false };
    case 'withdrawal':
      return { category: 'transfer-out', skip: false };
    case 'trade':
      return { category: 'other', skip: false };
    case 'split':
      return { category: 'other', skip: true };
    default:
      return { category: a.txn.amount < 0 ? 'expense' : a.txn.amount > 0 ? 'income' : 'other', skip: false };
  }
}

// ─── Step 7: Positions ───

function stepPositions(result: ConsolidatedResult, statements: ParsedStatement[], registry: AccountRegistry): void {
  for (const s of statements) {
    const label = registry.label(s.account.id);
    for (const p of s.positions) {
      const c: ConsolidatedPosition = {
        ...p,
        id: generateId(),
        accountLabel: label,
        sourceFiles: [s.file],
      };
      result.positions.push(c);
    }
  }
}

// ─── Step 8: Realized P/L ───

function stepRealized(result: ConsolidatedResult, statements: ParsedStatement[], registry: AccountRegistry): void {
  for (const s of statements) {
    const label = registry.label(s.account.id);
    for (const r of s.realized) {
      const c: ConsolidatedRealized = {
        ...r,
        id: generateId(),
        accountLabel: label,
        sourceFiles: [s.file],
      };
      result.realized.push(c);
    }
  }
}

