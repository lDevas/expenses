import { daysBetween, withinDays, type ConsolidatedExchange } from '../types.ts';
import { BROKER_WIRE_KEYWORDS, accountNumberMatches } from '../registry.ts';
import type { CtxTxn } from './pairing.ts';

type Rate = { date: Date; rate: number };
type Candidate = { broker: CtxTxn; bank: CtxTxn; named: boolean; amountDelta: number; days: number };

// Fees reduce the amount received. Preserve the previous one-unit rounding
// allowance, but bound fee deductions to 1% and 100 original-currency units.
const feeAllowance = (sent: number) => Math.max(1, Math.min(sent * 0.01, 100));
const genericWire = (description: string) => /^(?:DEB\.\s*CAMBIOSST|CRE\.\s*CAMBIOSOP)/i.test(description.trim());
const brokerName = (value: string) => /INTERACTIVE[\s-]+BROKERS|\bIBKR\b/i.test(value) ? 'ibkr'
  : /ETORO/i.test(value) ? 'etoro' : undefined;

export function brokerWireRates(exchanges: ConsolidatedExchange[]): Rate[] {
  return exchanges.filter(exchange => exchange.matchStatus === 'matched' &&
    ['USD/UYU', 'UYU/USD'].includes(`${exchange.fromCurrency}/${exchange.toCurrency}`) &&
    (exchange.impliedRate ?? 0) > 0 && (exchange.fromAmount ?? 0) > 0 && (exchange.toAmount ?? 0) > 0)
    .map(exchange => ({ date: exchange.date ?? new Date(),
      rate: exchange.fromCurrency === 'USD' ? exchange.impliedRate! : 1 / exchange.impliedRate! }));
}

/** Plan pairs together, so an ambiguous row cannot steal another broker's wire. */
export function matchBrokerWires(brokers: CtxTxn[], banks: CtxTxn[], rates: Rate[]): Map<CtxTxn, CtxTxn> {
  const candidates: Candidate[] = [];
  for (const broker of brokers) for (const bank of banks) {
    if (broker.consumed || bank.consumed || !['deposit', 'withdrawal'].includes(broker.txn.kind)) continue;
    if (bank.account.isCard || !['checking', 'savings'].includes(bank.account.type)) continue;
    if (!['transfer-in', 'transfer-out', 'other', 'deposit', 'withdrawal'].includes(bank.txn.kind)) continue;
    const description = `${bank.txn.description} ${bank.txn.counterparty ?? ''}`.toUpperCase();
    const named = BROKER_WIRE_KEYWORDS.some(keyword => description.includes(keyword));
    if (!named && !genericWire(bank.txn.description)) continue;
    const bankBroker = brokerName(description);
    const accountBroker = brokerName(`${broker.account.id} ${broker.account.institutionName} ${broker.account.label}`);
    if (bankBroker && accountBroker && bankBroker !== accountBroker) continue;
    // A supplied recipient is evidence, not an operation number from the memo.
    // Generic rows pointing at another account must never match by amount alone.
    if (!named && bank.txn.counterparty &&
        (!broker.account.number || !accountNumberMatches(bank.txn.counterparty, broker.account.number))) continue;
    if (!Number.isFinite(broker.txn.amount) || !Number.isFinite(bank.txn.amount) ||
        !broker.txn.amount || Math.sign(bank.txn.amount) !== -Math.sign(broker.txn.amount)) continue;
    if (!withinDays(broker.txn.date, bank.txn.date, 2)) continue;

    const brokerAmount = Math.abs(broker.txn.amount), bankAmount = Math.abs(bank.txn.amount);
    let amountDelta: number;
    if (broker.txn.currency === bank.txn.currency) {
      const sent = broker.txn.amount < 0 ? brokerAmount : bankAmount;
      const received = broker.txn.amount < 0 ? bankAmount : brokerAmount;
      const shortfall = sent - received;
      if (shortfall < -1.00000001 || shortfall > feeAllowance(sent) + 0.00000001) continue;
      amountDelta = Math.abs(shortfall) / sent;
    } else {
      // Keep the established FX tolerance; don't infer a fee across currencies.
      if (![broker.txn.currency, bank.txn.currency].every(currency => currency === 'USD' || currency === 'UYU')) continue;
      const rate = closestRate(rates, broker.txn.date);
      if (!rate) continue;
      const expected = broker.txn.currency === 'USD' ? brokerAmount * rate : brokerAmount / rate;
      amountDelta = Math.abs(bankAmount - expected) / expected;
      if (amountDelta > 0.03 + 0.00000001) continue;
    }
    candidates.push({ broker, bank, named, amountDelta, days: Math.abs(daysBetween(broker.txn.date, bank.txn.date)) });
  }

  const pairs = new Map<CtxTxn, CtxTxn>();
  const usedBanks = new Set<CtxTxn>();
  // Named rows provide stronger evidence than generic interbank codes. Resolve
  // mutually unique best matches first; ties stay unmatched, regardless of order.
  const named = candidates.filter(candidate => candidate.named);
  for (const candidate of named) {
    if (uniqueBest(named.filter(row => row.broker === candidate.broker)) === candidate &&
        uniqueBest(named.filter(row => row.bank === candidate.bank)) === candidate) {
      pairs.set(candidate.broker, candidate.bank);
      usedBanks.add(candidate.bank);
    }
  }
  const remaining = candidates.filter(candidate => !pairs.has(candidate.broker) && !usedBanks.has(candidate.bank));
  for (const candidate of remaining) {
    // Date/amount alone cannot choose among multiple compatible generic wires.
    if (remaining.filter(row => row.broker === candidate.broker).length === 1 &&
        remaining.filter(row => row.bank === candidate.bank).length === 1) pairs.set(candidate.broker, candidate.bank);
  }
  return pairs;
}

function uniqueBest(candidates: Candidate[]): Candidate | undefined {
  const ordered = [...candidates].sort((a, b) => a.amountDelta - b.amountDelta || a.days - b.days);
  if (!ordered.length) return undefined;
  if (ordered.length > 1 && Math.abs(ordered[0].amountDelta - ordered[1].amountDelta) < 1e-9 && ordered[0].days === ordered[1].days) return undefined;
  return ordered[0];
}

function closestRate(rates: Rate[], on: Date): number | undefined {
  const ordered = [...rates].filter(row => row.rate > 0 && Number.isFinite(row.rate))
    .sort((a, b) => Math.abs(daysBetween(a.date, on)) - Math.abs(daysBetween(b.date, on)));
  if (!ordered.length) return undefined;
  return Math.abs(daysBetween(ordered[0].date, on)) > 90
    ? ordered.reduce((sum, row) => sum + row.rate, 0) / ordered.length : ordered[0].rate;
}
