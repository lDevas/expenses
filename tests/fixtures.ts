import Database from 'better-sqlite3';
import { applySchema } from '../server/db/schemaSql.ts';
import { DatabaseQueries } from '../server/db/queries.ts';
import { parseStatementDate, type ParsedStatement, type RawTxn } from '../server/ingestion/types.ts';

export const date = (value: string) => parseStatementDate(value)!;

export function statement(id = 'bank', changes: Partial<ParsedStatement> = {}): ParsedStatement {
  return {
    kind: 'santander-umsatz', file: `${id}.csv`,
    account: { id, institutionId: 'test-bank', institutionName: 'Test Bank', name: id,
      type: 'checking', currency: 'UYU', number: id,
      periodFrom: date('2026-09-01'), periodTo: date('2026-09-30'), periodSource: 'statement' },
    transactions: [], positions: [], realized: [], summary: {}, issues: [], ...changes,
  };
}

export function txn(accountId = 'bank', changes: Partial<RawTxn> = {}): RawTxn {
  return { accountId, date: date('2026-09-10'), description: 'Purchase', amount: -45,
    currency: 'UYU', kind: 'purchase', ...changes };
}

export function setup() {
  const sql = new Database(':memory:');
  sql.pragma('foreign_keys = ON');
  applySchema(sql);
  return { sql, q: new DatabaseQueries(sql) };
}

export function pairedStatements(): ParsedStatement[] {
  const bank = statement('bank');
  bank.transactions = [txn(), txn(), txn('bank', { kind: 'fx', amount: -40000, reference: 'FX1' }),
    txn('bank', { kind: 'card-payment', amount: -90, description: 'Pay card' })];
  const usd = statement('usd');
  usd.account.currency = 'USD';
  usd.transactions = [txn('usd', { kind: 'fx', amount: 1000, currency: 'USD', reference: 'FX1' })];
  const card = statement('card');
  card.account.type = 'credit';
  card.transactions = [txn('card', { kind: 'card-payment', amount: -90, description: 'Card payment' }),
    txn('card', { amount: 45 }), txn('card', { amount: 45 })];
  return [bank, usd, card];
}
