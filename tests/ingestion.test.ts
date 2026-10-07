import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as XLSX from 'xlsx';
import { consolidate } from '../server/ingestion/consolidation.ts';
import { parseSantanderCardXls } from '../server/ingestion/parsers/santanderCardXls.ts';
import { parseSantanderUmsatz } from '../server/ingestion/parsers/santanderUmsatz.ts';
import { toISODate } from '../server/ingestion/types.ts';
import { date, pairedStatements, statement, txn } from './fixtures.ts';

test('card CSV keeps DD/MM text in Latin-1 and UTF-8, including days <= 12', () => {
  const csv = 'Número de tarjeta de crédito,Alias\nXXXX-1234,Test\nFecha,Número de tarjeta,Descripción,Pesos,Dólares\n04/12/2025,1234,Café,45,0\n13/12/2025,1234,Café,45,0\n31/12/2025,1234,Té,0,12\n';
  for (const encoding of ['latin1', 'utf8'] as const) {
    const s = parseSantanderCardXls(Buffer.from(csv, encoding), 'CreditCardsMovementsDetail.csv');
    assert.equal(s.account.id, 'santander-card-1234');
    assert.deepEqual(s.transactions.map(t => toISODate(t.date)), ['2025-12-04', '2025-12-13', '2025-12-31']);
    assert.equal(s.transactions[0].description, 'Café');
    assert.deepEqual(s.issues, []);
  }
});

test('real Excel numeric date cells still parse', () => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['Fecha', 'Número de tarjeta', 'Descripción', 'Pesos', 'Dólares'],
    [45995, '1234', 'Purchase', 45, 0],
  ]), 'Card');
  const s = parseSantanderCardXls(XLSX.write(workbook, { type: 'buffer', bookType: 'xls' }), 'card.xls');
  assert.equal(s.transactions.length, 1);
  assert.equal(toISODate(s.transactions[0].date), '2025-12-04');
});

test('Santander balance uses the newest dated row, not the final row', () => {
  const header = 'Número,123456\nMoneda,UYU\nFecha,Referencia,Concepto,Descripción,Débito,Crédito,Saldos\n';
  const rows = ['30/09/2026,3,Compra,Latest,-10,0,2043.74',
    '30/09/2026,2,Compra,Earlier on same date,-20,0,2053.74',
    '01/09/2026,1,Compra,Oldest,-10,0,40000'];
  const s = parseSantanderUmsatz(Buffer.from(header + rows.join('\n'), 'latin1'), 'umsatz.csv');
  assert.equal(s.account.closingBalance, 2043.74);
  assert.equal(toISODate(s.account.balanceDate!), '2026-09-30');
  const unordered = parseSantanderUmsatz(Buffer.from(header + [rows[2], rows[0]].join('\n'), 'latin1'), 'umsatz.csv');
  assert.equal(unordered.account.closingBalance, 2043.74);
});

test('overlapping/duplicate exports preserve repeated purchases and deduplicate before investment netting', () => {
  const bank = statement();
  bank.transactions = [txn(), txn()];
  const overlap = { ...bank, file: 'overlap.csv', transactions: [txn()] };
  const broker = statement('broker');
  broker.account.type = 'investment';
  broker.transactions = [txn('broker', { kind: 'dividend', amount: 100, counterparty: 'ABC' }),
    txn('broker', { kind: 'withholding', amount: -30, counterparty: 'ABC' })];
  broker.positions = [{ accountId: 'broker', symbol: 'ABC', qty: 2, costBasis: 100, value: 120, currency: 'USD', snapshotDate: date('2026-09-30') }];
  broker.realized = [{ accountId: 'broker', symbol: 'ABC', date: date('2026-09-10'), realizedPl: 513.48616, currency: 'USD' }];
  const input = [bank, overlap, broker, { ...broker, file: 'broker-copy.csv' }];
  const before = JSON.stringify(input);
  const result = consolidate(input);
  assert.equal(JSON.stringify(input), before, 'pure engine must not mutate sources');
  assert.equal(result.items.filter(i => i.accountId === 'bank').length, 2);
  assert.deepEqual(result.items.find(i => i.accountId === 'broker')?.amount, 70);
  assert.equal(result.positions.length, 1);
  assert.equal(result.realized.reduce((sum, r) => sum + r.realizedPl, 0), 513.48616);
  assert.deepEqual(result.positions[0].sourceFiles.sort(), ['broker-copy.csv', 'broker.csv']);
  assert.deepEqual(result.items.find(i => i.accountId === 'broker')!.sourceFiles.sort(), ['broker-copy.csv', 'broker.csv']);
});

test('dividend withholding is isolated by account and currency, including net dividends', () => {
  const a = statement('a'), b = statement('b'), net = statement('net');
  for (const s of [a, b, net]) s.account.type = 'investment';
  a.transactions = [txn('a', { kind: 'dividend', amount: 100, currency: 'USD', counterparty: 'ABC' }),
    txn('a', { kind: 'withholding', amount: -30, currency: 'USD', counterparty: 'ABC' }),
    txn('a', { kind: 'dividend', amount: 200, currency: 'EUR', counterparty: 'ABC' }),
    txn('a', { kind: 'withholding', amount: -20, currency: 'EUR', counterparty: 'ABC' })];
  b.transactions = [txn('b', { kind: 'dividend', amount: 50, currency: 'USD', counterparty: 'ABC' }),
    txn('b', { kind: 'withholding', amount: -15, currency: 'USD', counterparty: 'ABC' })];
  net.transactions = [txn('net', { kind: 'dividend', amount: 25, currency: 'USD', counterparty: 'ABC', metadata: { gross: 30, withholdingTax: 5 } })];
  const items = consolidate([a, b, net]).items;
  assert.deepEqual(items.map(i => [i.accountId, i.currency, i.amount, i.metadata?.withholdingTax]).sort(),
    [['a', 'EUR', 180, 20], ['a', 'USD', 70, 30], ['b', 'USD', 35, 15], ['net', 'USD', 25, 5]]);
});

test('overlap dedup retains source-row adjacency for card tax reimbursements', () => {
  const card = statement('card');
  card.account.type = 'credit';
  card.transactions = [txn('card', { amount: 100, description: 'First merchant' }),
    txn('card', { kind: 'refund', amount: -10, description: 'REDUC. IVA' }),
    txn('card', { amount: 200, description: 'Second merchant' }),
    txn('card', { kind: 'refund', amount: -20, description: 'REDUC. IVA' })];
  // Whichever export wins the dedup sort, refunds must keep their own purchase.
  const partial = { ...card, file: 'partial.csv', transactions: [card.transactions[2], card.transactions[0]] };
  for (const sources of [[card, partial], [partial, card]]) {
    assert.deepEqual(consolidate(sources).items.map(i => [i.description, i.amount]).sort(),
      [['First merchant', -90], ['Second merchant', -180]]);
  }
});

test('FX rates retain precision, and broker matching respects both rate and wire directions', () => {
  for (const reverseFx of [false, true]) for (const withdrawal of [false, true]) for (const brokerCurrency of ['USD', 'UYU']) {
    const [bank, usd] = pairedStatements();
    bank.transactions = bank.transactions.filter(t => t.kind === 'fx');
    if (reverseFx) { bank.transactions[0].amount *= -1; usd.transactions[0].amount *= -1; }
    const broker = statement('broker');
    broker.account.type = 'investment';
    const brokerAmount = brokerCurrency === 'USD' ? 500 : 20000;
    broker.transactions = [txn('broker', { kind: withdrawal ? 'withdrawal' : 'deposit',
      amount: withdrawal ? -brokerAmount : brokerAmount, currency: brokerCurrency })];
    const bankSide = brokerCurrency === 'USD' ? bank : usd;
    const bankAmount = brokerCurrency === 'USD' ? 20000 : 500;
    bankSide.transactions.push(txn(bankSide.account.id, { description: 'INTERACTIVE BROKERS wire', kind: 'other',
      amount: withdrawal ? bankAmount : -bankAmount, currency: bankSide.account.currency }));
    const r = consolidate([bank, usd, broker]);
    assert.equal(r.exchanges[0].impliedRate, reverseFx ? 40 : 0.025);
    assert.equal(r.transfers.length, 1);
    const wire = r.transfers[0];
    assert.equal(wire.matchStatus, 'matched');
    assert.equal(wire.impliedRate, wire.toAmount! / wire.fromAmount!);
    assert.equal(r.items.length, 0);
  }
});
