import type { ConsolidatedResult, ConsolidatedTransfer } from '../types.ts';
import { generateId, daysBetween, withinDays } from '../types.ts';
import { AccountRegistry, accountNumberMatches } from '../registry.ts';
import { consumePair, type CtxTxn } from './pairing.ts';

const round2 = (n: number) => Math.round(n * 100) / 100;
const files = (...rows: CtxTxn[]) => [...new Set(rows.flatMap(r => r.txn.sourceFiles ?? [r.file]))];
const movement = (r: CtxTxn) => !r.account.isCard && r.account.type !== 'investment' &&
  ['transfer-in', 'transfer-out', 'fx'].includes(r.txn.kind);
const links = (a: CtxTxn, b: CtxTxn) => !!(a.txn.counterparty && b.account.number &&
  accountNumberMatches(a.txn.counterparty, b.account.number));
const operationReference = (r: CtxTxn) => r.txn.reference && !/^CAMBIO$/i.test(r.txn.reference)
  ? r.txn.reference : undefined;

/** Reconcile owned movements, keeping all principal out of financial items. */
export function stepOwnMovements(result: Pick<ConsolidatedResult, 'transfers' | 'exchanges'>, all: CtxTxn[], registry: AccountRegistry): CtxTxn[] {
  const rows = all.filter(movement);
  const owned = (r: CtxTxn) => r.txn.kind === 'fx' || registry.isOwnCounterparty(r.txn.counterparty);
  // Do not consume unmatched rows until every owned row has had a chance to pair.
  // Equal-currency/equal-amount matches provide stronger amount evidence and
  // must be settled before linked FX legs whose magnitudes cannot be compared.
  for (const sameCurrency of [true, false]) for (const a of rows) {
    if (a.consumed || !owned(a)) continue;
    const candidates = rows.filter(b => (b.txn.currency === a.txn.currency) === sameCurrency);
    const b = findPartner(a, rows, candidates, registry);
    if (!b) continue;
    consumePair(a, b);
    const from = a.txn.amount < 0 ? a : b;
    const to = from === a ? b : a;
    if (from.txn.currency !== to.txn.currency) {
      result.exchanges.push({
        id: generateId(), matchStatus: 'matched', accountId: from.account.id,
        accountLabel: `${from.account.label} ↔ ${to.account.label}`, date: from.txn.date,
        description: `Currency exchange: ${from.txn.description} ↔ ${to.txn.description}`,
        fromCurrency: from.txn.currency, fromAmount: round2(Math.abs(from.txn.amount)),
        toCurrency: to.txn.currency, toAmount: round2(Math.abs(to.txn.amount)),
        impliedRate: Math.abs(to.txn.amount / from.txn.amount), sourceFiles: files(from, to),
      });
    } else result.transfers.push(makeTransfer(from, to));
  }
  // Beyond counterparty ownership, every received bank transfer also pairs with
  // a bank transfer of the same value on a different account within
  // AMOUNT_WINDOW_DAYS — the pattern behind generic bank codes (CRE. CAMBIOSOP,
  // CARGA TRANSFERENCIA BANCARIA, Transferencia SPI) that name neither account.
  // It runs after the ownership passes so their stronger evidence settles first.
  for (const a of rows) {
    if (a.consumed || a.txn.kind !== 'transfer-in' || a.txn.amount <= 0) continue;
    const b = findAmountPartner(a, rows, registry);
    if (!b) continue;
    consumePair(a, b);
    const from = a.txn.amount < 0 ? a : b;
    const to = from === a ? b : a;
    result.transfers.push(makeTransfer(from, to));
  }
  for (const a of rows) {
    if (a.consumed || !owned(a)) continue;
    a.consumed = true;
    const target = registry.counterpartyAccount(a.txn.counterparty);
    const targetCurrency = target?.currencies.length === 1 ? target.currencies[0] : undefined;
    if (a.txn.kind === 'fx' || (targetCurrency && targetCurrency !== a.txn.currency)) {
      const debit = a.txn.amount < 0;
      result.exchanges.push({
        id: generateId(), matchStatus: 'unmatched', accountId: a.account.id,
        accountLabel: a.account.label, date: a.txn.date, description: a.txn.description,
        fromCurrency: debit ? a.txn.currency : targetCurrency,
        fromAmount: debit ? round2(Math.abs(a.txn.amount)) : undefined,
        toCurrency: debit ? targetCurrency : a.txn.currency,
        toAmount: debit ? undefined : round2(Math.abs(a.txn.amount)), sourceFiles: files(a),
      });
    } else {
      const transfer = makeTransfer(a.txn.amount < 0 ? a : undefined, a.txn.amount > 0 ? a : undefined);
      if (a.txn.amount < 0) { transfer.toAccountId = target?.id; transfer.toAccountLabel = target?.label ?? a.txn.counterparty ?? 'Own account (statement missing)'; }
      else { transfer.fromAccountId = target?.id; transfer.fromAccountLabel = target?.label ?? a.txn.counterparty ?? 'Own account (statement missing)'; }
      result.transfers.push(transfer);
    }
  }
  return rows.filter(row => row.consumed);
}

function findPartner(a: CtxTxn, rows: CtxTxn[], candidates: CtxTxn[], registry: AccountRegistry): CtxTxn | null {
  const best = findBestPartner(a, candidates, registry);
  // Both directions must be unique. Otherwise a later credit could consume
  // a debit that was deliberately left ambiguous earlier in the pass.
  const reverseCandidates = best && rows.filter(r => (r.txn.currency === best.txn.currency) === (a.txn.currency === best.txn.currency));
  return best && reverseCandidates && findBestPartner(best, reverseCandidates, registry) === a ? best : null;
}

function findBestPartner(a: CtxTxn, rows: CtxTxn[], registry: AccountRegistry): CtxTxn | null {
  const candidates: { row: CtxTxn; score: number }[] = [];
  for (const b of rows) {
    if (b === a || b.consumed || b.account.id === a.account.id) continue;
    if (!a.txn.amount || !b.txn.amount || Math.sign(a.txn.amount) === Math.sign(b.txn.amount)) continue;
    const sameBank = a.account.institutionId === b.account.institutionId;
    if (!withinDays(a.txn.date, b.txn.date, sameBank ? 1 : 3)) continue;
    const ab = links(a, b), ba = links(b, a);
    if (a.txn.counterparty && /\d{5,}/.test(a.txn.counterparty.replace(/[ .-]/g, '')) && !ab) continue;
    if (b.txn.counterparty && /\d{5,}/.test(b.txn.counterparty.replace(/[ .-]/g, '')) && !ba) continue;
    // A supplied counterparty must identify the opposite own account, not a
    // third party (even if a coincidental amount/date/reference agrees).
    if (a.txn.counterparty && !ab && !registry.isOwnCounterparty(a.txn.counterparty)) continue;
    if (b.txn.counterparty && !ba && !registry.isOwnCounterparty(b.txn.counterparty)) continue;
    const targetA = registry.counterpartyAccount(a.txn.counterparty);
    const targetB = registry.counterpartyAccount(b.txn.counterparty);
    if (targetA && targetA.id !== b.account.id || targetB && targetB.id !== a.account.id) continue;
    const refA = operationReference(a), refB = operationReference(b);
    const ref = !!(refA && refB && refA === refB);
    const sameCurrency = a.txn.currency === b.txn.currency;
    if (sameCurrency) {
      if (Math.abs(Math.abs(a.txn.amount) - Math.abs(b.txn.amount)) > 0.010000001) continue;
      if (!ab && !ba && !registry.isOwnCounterparty(a.txn.counterparty) && !registry.isOwnCounterparty(b.txn.counterparty)) continue;
    } else {
      // Cross-currency magnitudes cannot be compared. Require an account link
      // or the bank's shared FX operation ID; dates alone are insufficient.
      if (!ab && !ba && !(sameBank && ref && a.txn.kind === 'fx' && b.txn.kind === 'fx')) continue;
      if (!ab && !ba && refA && refB && refA !== refB) continue;
    }
    const evidence = ab && ba ? 4 : ab || ba ? 3 : ref ? 2 : 1;
    candidates.push({ row: b, score: evidence * 10 + (ref ? 5 : 0) - Math.abs(daysBetween(a.txn.date, b.txn.date)) });
  }
  candidates.sort((a, b) => b.score - a.score);
  // Ambiguous movements stay visibly unmatched; never guess between two legs.
  return candidates.length && (candidates.length === 1 || candidates[0].score > candidates[1].score)
    ? candidates[0].row : null;
}

// ─── Value-based pairing for received transfers ───

const AMOUNT_TOLERANCE = 0.010000001;
// Deposits can post days after the sender's entry (up to a week).
const AMOUNT_WINDOW_DAYS = 8;
const explicitAccount = (r: CtxTxn) => !!(r.txn.counterparty && /\d{5,}/.test(r.txn.counterparty.replace(/[ .-]/g, '')));

/**
 * Eligibility of a value pair: `receiver` is the received transfer (credit) and
 * `sender` the sending transfer (debit). Unlike the ownership pairing, neither
 * counterparty needs to identify the other account — equal value, same currency,
 * a different account, and dates within the deposit window carry the evidence.
 * An explicit account number on either leg pins a specific
 * counterparty account and vetoes a pair it does not link; a plain name never
 * vetoes.
 */
function amountPairEligible(receiver: CtxTxn, sender: CtxTxn, registry: AccountRegistry): boolean {
  if (receiver.account.id === sender.account.id) return false;
  if (receiver.txn.amount <= 0 || sender.txn.amount >= 0) return false;
  if (receiver.txn.currency !== sender.txn.currency) return false;
  if (Math.abs(Math.abs(receiver.txn.amount) - Math.abs(sender.txn.amount)) > AMOUNT_TOLERANCE) return false;
  if (!withinDays(receiver.txn.date, sender.txn.date, AMOUNT_WINDOW_DAYS)) return false;
  if (explicitAccount(receiver) && !links(receiver, sender)) return false;
  if (explicitAccount(sender) && !links(sender, receiver)) return false;
  const targetReceiver = registry.counterpartyAccount(receiver.txn.counterparty);
  if (targetReceiver && targetReceiver.id !== sender.account.id) return false;
  const targetSender = registry.counterpartyAccount(sender.txn.counterparty);
  if (targetSender && targetSender.id !== receiver.account.id) return false;
  return true;
}

/** Same evidence scale as the ownership pairing: account links > shared reference > day proximity. */
function amountPartnerScore(anchor: CtxTxn, other: CtxTxn): number {
  const ab = links(anchor, other), ba = links(other, anchor);
  const refA = operationReference(anchor), refB = operationReference(other);
  const ref = !!(refA && refB && refA === refB);
  const evidence = ab && ba ? 4 : ab || ba ? 3 : ref ? 2 : 1;
  return evidence * 10 + (ref ? 5 : 0) - Math.abs(daysBetween(anchor.txn.date, other.txn.date));
}

function bestAmountPartner(anchor: CtxTxn, pool: CtxTxn[], registry: AccountRegistry): CtxTxn | null {
  const anchorReceives = anchor.txn.kind === 'transfer-in';
  const candidates = pool
    .filter(r => r !== anchor && !r.consumed &&
      (anchorReceives ? amountPairEligible(anchor, r, registry) : amountPairEligible(r, anchor, registry)))
    .map(r => ({ row: r, score: amountPartnerScore(anchor, r) }))
    .sort((x, y) => y.score - x.score);
  // Ambiguous movements stay visibly in the financial items; never guess a leg.
  return candidates.length && (candidates.length === 1 || candidates[0].score > candidates[1].score)
    ? candidates[0].row : null;
}

/** Find the sending leg for a received transfer, uniquely in both directions. */
function findAmountPartner(a: CtxTxn, rows: CtxTxn[], registry: AccountRegistry): CtxTxn | null {
  const best = bestAmountPartner(a, rows.filter(r => r.txn.kind === 'transfer-out'), registry);
  if (!best) return null;
  // The sending leg must single this receipt out among every same-value receipt
  // it could feed; a debit that could equally feed another receipt is ambiguous.
  const reverse = bestAmountPartner(best, rows.filter(r => r.txn.kind === 'transfer-in'), registry);
  return reverse === a ? best : null;
}

function makeTransfer(from: CtxTxn | undefined, to: CtxTxn | undefined): ConsolidatedTransfer {
  return {
    id: generateId(), kind: 'internal', matchStatus: from && to ? 'matched' : 'unmatched',
    fromAccountId: from?.account.id, fromAccountLabel: from?.account.label ?? 'Own account (statement missing)',
    fromCurrency: from?.txn.currency, fromAmount: from && round2(Math.abs(from.txn.amount)),
    fromDate: from?.txn.date, fromDescription: from?.txn.description,
    toAccountId: to?.account.id, toAccountLabel: to?.account.label ?? 'Own account (statement missing)',
    toCurrency: to?.txn.currency, toAmount: to && round2(Math.abs(to.txn.amount)),
    toDate: to?.txn.date, toDescription: to?.txn.description,
    sourceFiles: files(...[from, to].filter((r): r is CtxTxn => !!r)),
  };
}
