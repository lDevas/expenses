import type {
  ConsolidatedCategory,
  ConsolidatedItem,
  ConsolidatedPosition,
  ConsolidatedRealized,
  ConsolidatedResult,
  Issue,
  ParsedStatement,
} from './types.ts';
import { generateId, toISODate, withinDays } from './types.ts';
import { AccountRegistry, type RegistryAccount } from './registry.ts';
import { deduplicateStatements, itemFingerprint } from './identity.ts';
import type { CtxTxn } from './consolidation/pairing.ts';
import { ctxOf, findPair, consumePair } from './consolidation/pairing.ts';
import { stepBalances } from './consolidation/balances.ts';
import { stepOwnMovements } from './consolidation/movements.ts';
import { normalizeMovements } from './consolidation/normalize.ts';
import { brokerWireRates, matchBrokerWires } from './consolidation/brokerWires.ts';

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
  // One file can back multiple statements (multi-currency ledgers); report it once.
  const files = [...new Set(statements.map(s => s.file))];
  statements = deduplicateStatements(normalizeMovements(statements));
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
    files,
    items: [],
    transfers: [],
    exchanges: [],
    positions: [],
    realized: [],
    balances: [],
    issues,
  };

  stepCardPayments(result, all);
  stepOwnMovements(result, all, registry);
  stepBroker(result, all);
  stepReimbursements(result, all);
  stepItems(result, all);
  stepPositions(result, statements, registry);
  stepRealized(result, statements, registry);
  stepBalances(result, statements, registry);

  result.items.sort((a, b) => a.date.getTime() - b.date.getTime() || a.accountLabel.localeCompare(b.accountLabel));
  result.balances.sort((a, b) => a.date.getTime() - b.date.getTime() || a.accountId.localeCompare(b.accountId));
  return result;
}

/** Proven principal rows for report projections, including old immutable runs. */
export function ownMovementKeys(statements: ParsedStatement[]): Set<string> {
  const sources = deduplicateStatements(normalizeMovements(statements));
  const registry = AccountRegistry.from(sources);
  const rows = sources.flatMap(s => s.transactions.map(t => ctxOf(s, registry.get(s.account.id)!, t)));
  const movements: Pick<ConsolidatedResult, 'transfers' | 'exchanges'> = { transfers: [], exchanges: [] };
  const owned = stepOwnMovements(movements, rows, registry);
  const brokers = rows.filter(row => row.account.type === 'investment' && ['deposit', 'withdrawal'].includes(row.txn.kind));
  const wires = matchBrokerWires(brokers, rows.filter(row => row.account.type !== 'investment'), brokerWireRates(movements.exchanges));
  return new Set([...owned, ...brokers, ...wires.values()].map(row => itemFingerprint(row.txn)));
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

function dedup(list: string[]): string[] {
  return [...new Set(list)];
}

function sourceFiles(...rows: (CtxTxn | null | undefined)[]): string[] {
  return dedup(rows.flatMap(t => t ? t.txn.sourceFiles ?? [t.file] : []));
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
    sourceFiles: sourceFiles(a, partner),
  };
  result.items.push(item);
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
      sourceFiles: sourceFiles(a, b),
    });
  }
}

// ─── Step 4: Broker accounts (wires, dividends, interest, trades) ───

function stepBroker(result: ConsolidatedResult, all: CtxTxn[]): void {
  const brokerTxns = all.filter((t) => t.account.type === 'investment');
  const bankTxns = all.filter((t) => t.account.type !== 'investment');

  // implied UYU/USD rates from the matched FX pairs (period rate pool)
  const rates = brokerWireRates(result.exchanges);

  const wirePairs = matchBrokerWires(brokerTxns, bankTxns, rates);
  // 1. cash-boundary events → transfers list (always hidden from items)
  for (const a of brokerTxns) {
    if (a.consumed) continue;
    if (a.txn.kind !== 'deposit' && a.txn.kind !== 'withdrawal') continue;
    const b = wirePairs.get(a) ?? null;
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
      impliedRate: b && a.txn.currency !== b.txn.currency && Math.abs(a.txn.amount) > 0 ? (brokerIsFrom ? Math.abs(b.txn.amount / a.txn.amount) : Math.abs(a.txn.amount / b.txn.amount)) : undefined,
      sourceFiles: sourceFiles(a, b),
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
  const divKey = (t: CtxTxn) => JSON.stringify([t.account.id, t.txn.currency, toISODate(t.txn.date), t.txn.counterparty ?? '']);
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
      sourceFiles: sourceFiles(...group, ...taxGroup),
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
      let closest = Infinity;
      for (const b of all) {
        if (b.consumed || b.account.id !== a.account.id) continue;
        if (b.txn.currency !== a.txn.currency) continue;
        if (b.txn.kind !== 'purchase' || b.txn.amount <= 0) continue;
        if (!withinDays(a.txn.date, b.txn.date, 0)) continue;
        // Deduplication can place the purchase in another export. Use original
        // source-row order, not the flattened/deduplicated array's adjacency.
        for (const refundRow of a.txn.sourceRows ?? []) for (const purchaseRow of b.txn.sourceRows ?? []) {
          const distance = refundRow.index - purchaseRow.index;
          if (refundRow.statement === purchaseRow.statement && distance > 0 && distance < closest) {
            closest = distance;
            partner = b;
          }
        }
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
      sourceFiles: sourceFiles(a, partner),
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
        sourceFiles: p.sourceFiles ?? [s.file],
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
        sourceFiles: r.sourceFiles ?? [s.file],
      };
      result.realized.push(c);
    }
  }
}
