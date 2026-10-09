import type { ParsedAccount, ParsedStatement, ParsedAccountType } from './types.ts';

/**
 * Account registry — the semantic knowledge consolidation relies on.
 * Static entries capture the user's known accounts (including own accounts that may not
 * have a file in the current batch); discovered entries come from the parsed file headers.
 */

export interface RegistryAccount {
  id: string;
  institutionId: string;
  institutionName: string;
  type: ParsedAccountType;
  /** currencies this account can hold (cards bill in two) */
  currencies: string[];
  /** true for credit-card accounts (settle, don't spend cash directly) */
  isCard: boolean;
  number?: string;
  label: string;
}

/**
 * Known owned bank accounts. Being another Itaú account (including iLink) is not
 * ownership evidence. Only these or accounts discovered in statement headers can
 * identify numeric counterparties as owned when their statement is absent.
 */
export const OWN_ACCOUNT_NUMBERS = [
  '3142914', // Itau UYU savings
  '3142920', // Itau USD savings
  '005200910615', // Santander USD
  '001200769690', // Santander UYU
];

/** Counterparty keywords identifying a broker wire on the bank side of a transfer. */
export const BROKER_WIRE_KEYWORDS = ['INTERACTIVE BROKERS', 'IBKR', 'ETORO', 'ETOROTRADING', 'BROKER'];

const STATIC: RegistryAccount[] = [
  { id: 'itau-3142914', institutionId: 'itau-uy', institutionName: 'Itau Uruguay', type: 'savings', currencies: ['UYU'], isCard: false, number: '3142914', label: 'Itau savings 3142914 (UYU)' },
  { id: 'itau-3142920', institutionId: 'itau-uy', institutionName: 'Itau Uruguay', type: 'savings', currencies: ['USD'], isCard: false, number: '3142920', label: 'Itau savings 3142920 (USD)' },
  { id: 'itau-card-0458553', institutionId: 'itau-uy', institutionName: 'Itau Uruguay', type: 'credit', currencies: ['UYU', 'USD'], isCard: true, number: '0458553', label: 'Itau Visa iLink *0458553*' },
  { id: 'santander-005200910615', institutionId: 'santander-uy', institutionName: 'Santander Uruguay', type: 'checking', currencies: ['USD'], isCard: false, number: '005200910615', label: 'Santander 005200910615 (USD)' },
  { id: 'santander-001200769690', institutionId: 'santander-uy', institutionName: 'Santander Uruguay', type: 'checking', currencies: ['UYU'], isCard: false, number: '001200769690', label: 'Santander 001200769690 (UYU)' },
  { id: 'santander-card-8174', institutionId: 'santander-uy', institutionName: 'Santander Uruguay', type: 'credit', currencies: ['UYU', 'USD'], isCard: true, number: '8174', label: 'Santander Visa *8174*' },
  { id: 'ibkr-U17277232', institutionId: 'interactive-brokers', institutionName: 'Interactive Brokers', type: 'investment', currencies: ['USD'], isCard: false, number: 'U17277232', label: 'IBKR U17277232' },
  { id: 'etoro-trading', institutionId: 'etoro', institutionName: 'eToro', type: 'investment', currencies: ['USD'], isCard: false, label: 'eToro trading' },
];

export class AccountRegistry {
  private accounts = new Map<string, RegistryAccount>();
  private holders = new Set<string>();

  constructor() {
    for (const a of STATIC) this.accounts.set(a.id, a);
  }

  static from(statements: ParsedStatement[]): AccountRegistry {
    const reg = new AccountRegistry();
    for (const s of statements) {
      reg.merge(s.account);
    }
    return reg;
  }

  merge(acc: ParsedAccount): void {
    if (acc.holder) this.holders.add(acc.holder);
    const existing = this.accounts.get(acc.id);
    const currencies = new Set<string>(acc.currency ? [acc.currency] : []);
    if (existing) {
      for (const c of existing.currencies) currencies.add(c);
      this.accounts.set(acc.id, {
        ...existing,
        institutionId: acc.institutionId || existing.institutionId,
        institutionName: acc.institutionName || existing.institutionName,
        type: acc.type,
        isCard: existing.isCard || acc.type === 'credit',
        number: acc.number || existing.number,
        label: acc.name && acc.name !== 'Itau cuenta' && acc.name !== 'Santander cuenta' ? acc.name : existing.label,
        currencies: [...currencies],
      });
    } else {
      this.accounts.set(acc.id, {
        id: acc.id,
        institutionId: acc.institutionId,
        institutionName: acc.institutionName,
        type: acc.type,
        currencies: [...currencies],
        isCard: acc.type === 'credit',
        number: acc.number,
        label: acc.name,
      });
    }
  }

  get(id: string): RegistryAccount | undefined {
    return this.accounts.get(id);
  }

  all(): RegistryAccount[] {
    return [...this.accounts.values()];
  }

  byInstitution(institutionId: string): RegistryAccount[] {
    return this.all().filter((a) => a.institutionId === institutionId);
  }

  label(id: string): string {
    return this.accounts.get(id)?.label ?? id;
  }

  /** Bank account identifiers are authoritative; never use a memo as owner evidence. */
  counterpartyAccount(counterparty: string | undefined): RegistryAccount | undefined {
    if (!counterparty) return undefined;
    return this.all().find(a => !a.isCard && a.number && accountNumberMatches(counterparty, a.number));
  }

  isOwnCounterparty(counterparty: string | undefined): boolean {
    if (!counterparty) return false;
    if (this.counterpartyAccount(counterparty) || isOwnAccountNumber(counterparty)) return true;
    // An explicit, unknown account number must not be overridden by a name.
    if (/\d{5,}/.test(counterparty)) return false;
    const words = nameWords(counterparty);
    return words.length >= 2 && [...this.holders].some(holder => {
      const owner = nameWords(holder);
      return words.every(word => owner.includes(word));
    });
  }
}

function nameWords(value: string): string[] {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase()
    .split(/[^A-Z]+/).filter(word => word.length > 1);
}

/** Match complete numeric tokens, allowing separators and omitted leading zeroes. */
export function accountNumberMatches(value: string, number: string): boolean {
  if (!/^\d{5,}$/.test(number.replace(/[\s.-]/g, ''))) return false;
  const normalize = (s: string) => s.replace(/\D/g, '').replace(/^0+/, '');
  const target = normalize(number);
  return (value.match(/\d(?:[\d .-]*\d)?/g) ?? []).some(token => normalize(token) === target);
}

export function isOwnAccountNumber(counterparty: string | undefined): boolean {
  if (!counterparty) return false;
  return OWN_ACCOUNT_NUMBERS.some(n => accountNumberMatches(counterparty, n));
}
