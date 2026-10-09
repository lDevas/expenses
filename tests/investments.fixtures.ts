import type { ParsedStatement } from '../server/ingestion/types.ts';
import { date, statement, txn } from './fixtures.ts';

export function investmentStatements(): ParsedStatement[] {
  const ibkr = statement('ibkr');
  ibkr.kind = 'ibkr-statement';
  ibkr.account = { ...ibkr.account, type: 'investment', currency: 'USD', institutionId: 'ibkr', institutionName: 'Interactive Brokers' };
  ibkr.summary = { 'NAV Cash total': 200, 'NAV Stock total': 99999 };
  const etoro = statement('etoro');
  etoro.kind = 'etoro-statement';
  etoro.account = { ...etoro.account, type: 'investment', currency: 'USD', institutionId: 'etoro', institutionName: 'eToro' };
  const position = (accountId: string, qty: number, costBasis: number, value: number, snapshot: string, symbol = 'URA') => ({
    accountId, qty, costBasis, value, symbol, currency: 'USD', snapshotDate: date(snapshot),
  });
  ibkr.positions = [position('ibkr', 100, 1000, 2000, '2026-07-01'),
    position('ibkr', 2, 100, 200, '2026-07-01', 'OLD'), position('ibkr', 10, 200, 300, '2026-09-28')];
  etoro.positions = [position('etoro', 20, 600, 700, '2026-06-30'), position('etoro', 5, 100, 150, '2026-06-30')];
  ibkr.transactions = [
    txn('ibkr', { kind: 'dividend', currency: 'USD', amount: 40, description: 'Dividend URA', counterparty: 'URA' }),
    txn('ibkr', { kind: 'withholding', currency: 'USD', amount: -10, counterparty: 'URA' }),
    txn('ibkr', { kind: 'interest', currency: 'USD', amount: 7, description: 'Broker interest' }),
    txn('ibkr', { kind: 'fee', currency: 'USD', amount: -3, description: 'Broker fee' }),
    txn('ibkr', { kind: 'deposit', currency: 'USD', amount: 1000, date: date('2026-09-15'), description: 'Wire received' }),
    txn('ibkr', { kind: 'deposit', currency: 'USD', amount: 50, date: date('2026-08-01'), description: 'Earlier wire' }),
  ];
  etoro.transactions = [
    txn('etoro', { kind: 'dividend', currency: 'USD', amount: 20, description: 'Dividend URA', counterparty: 'URA', metadata: { gross: 25, withholdingTax: 5 } }),
    txn('etoro', { kind: 'withdrawal', currency: 'USD', amount: -200, date: date('2026-09-20'), description: 'Wire sent' }),
    txn('etoro', { kind: 'deposit', currency: 'USD', amount: 500, date: new Date(2026, 8, 30, 23, 59), description: 'Unmatched wire received', metadata: { balanceAfter: 300 } }),
  ];
  ibkr.realized = [
    { accountId: 'ibkr', symbol: 'URA', date: date('2026-09-12'), currency: 'USD', realizedPl: 50, qty: -2, proceeds: 150, metadata: { code: 'C', side: 'sell' } },
    { accountId: 'ibkr', symbol: 'OPEN', date: date('2026-09-12'), currency: 'USD', realizedPl: 0, metadata: { code: 'O', side: 'buy' } },
    { accountId: 'ibkr', symbol: 'COVER', date: date('2026-09-12'), currency: 'USD', realizedPl: 0, metadata: { code: 'C', side: 'buy' } },
  ];
  const bank = statement('bank');
  bank.account.currency = 'USD';
  bank.account.closingBalance = 1234.50;
  bank.account.balanceDate = date('2026-09-30');
  bank.transactions = [
    txn('bank', { kind: 'fee', amount: -999, description: 'BANK FEE MUST NOT LEAK', currency: 'USD' }),
    txn('bank', { kind: 'interest', amount: 999, description: 'BANK INTEREST MUST NOT LEAK', currency: 'USD' }),
    txn('bank', { kind: 'transfer-out', amount: -1000, date: date('2026-09-15'), description: 'Wire INTERACTIVE BROKERS', currency: 'USD' }),
    txn('bank', { kind: 'transfer-in', amount: 200, date: date('2026-09-20'), description: 'Wire ETORO', currency: 'USD' }),
    txn('bank', { kind: 'transfer-in', amount: 123, description: 'Unrelated bank transfer', currency: 'USD' }),
  ];
  // Deliberately misclassified data must still be excluded by account type.
  bank.positions = [position('bank', 999, 999, 999, '2026-09-28', 'BANK')];
  bank.realized = [{ accountId: 'bank', symbol: 'BANK', date: date('2026-09-12'), currency: 'USD', realizedPl: 999 }];
  bank.issues = [{ file: 'bank.csv', severity: 'warning', message: 'BANK parsing issue must not leak' }];
  return [ibkr, etoro, bank];
}
