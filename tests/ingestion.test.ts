import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PDFParse } from 'pdf-parse';
import * as XLSX from 'xlsx';
import { consolidate } from '../server/ingestion/consolidation.ts';
import { detectStatementType } from '../server/ingestion/parsers/index.ts';
import { parseItauCardPdf } from '../server/ingestion/parsers/itauCardPdf.ts';
import { parseSantanderCardXls } from '../server/ingestion/parsers/santanderCardXls.ts';
import { parseSantanderUmsatz } from '../server/ingestion/parsers/santanderUmsatz.ts';
import { parsePrexXlsx } from '../server/ingestion/parsers/prexXlsx.ts';
import { toISODate } from '../server/ingestion/types.ts';
import { date, pairedStatements, prexWorkbook, statement, txn } from './fixtures.ts';

test('Itau card payments retain both currencies without reporting an ingestion issue', async (t) => {
  const text = '*0458553*\n04 08 26 PAGOS -12.345,67 -890,12\n05 08 26 PAGOS -100,00 -100,00\n';
  t.mock.method(PDFParse.prototype, 'getText', async () => ({
    text, pages: [], total: 1, getPageText: () => text,
  }));
  const card = await parseItauCardPdf(Buffer.alloc(0), 'infoV_202608.pdf');
  assert.deepEqual(card.issues, []);
  assert.deepEqual(card.transactions.map(row => [toISODate(row.date), row.kind, row.currency, row.amount]), [
    ['2026-08-04', 'card-payment', 'UYU', -12345.67],
    ['2026-08-04', 'card-payment', 'USD', -890.12],
    ['2026-08-05', 'card-payment', 'UYU', -100],
    ['2026-08-05', 'card-payment', 'USD', -100],
  ]);
  assert.equal(card.summary['card net UYU'], -12445.67);
  assert.equal(card.summary['card net USD'], -990.12);

  const cardOnly = consolidate([card]);
  assert.deepEqual(cardOnly.issues, []);
  assert.deepEqual(cardOnly.items.map(row => [row.category, row.currency, row.amount]), [
    ['card-payment', 'UYU', -12345.67], ['card-payment', 'USD', -890.12],
    ['card-payment', 'UYU', -100], ['card-payment', 'USD', -100],
  ]);

  const banks = ['UYU', 'USD'].map(currency => {
    const bank = statement(`bank-${currency}`);
    bank.account.institutionId = card.account.institutionId;
    bank.account.currency = currency;
    bank.transactions = card.transactions.filter(row => row.currency === currency)
      .map(row => ({ ...row, accountId: bank.account.id }));
    return bank;
  });
  const paired = consolidate([...banks, card]);
  assert.deepEqual(paired.issues, []);
  assert.deepEqual(paired.items, []);
  assert.deepEqual(paired.transfers.map(row => [row.kind, row.matchStatus, row.fromCurrency, row.toCurrency, row.fromAmount, row.toAmount]).sort(), [
    ['card', 'matched', 'UYU', 'UYU', 12345.67, 12345.67],
    ['card', 'matched', 'UYU', 'UYU', 100, 100],
    ['card', 'matched', 'USD', 'USD', 890.12, 890.12],
    ['card', 'matched', 'USD', 'USD', 100, 100],
  ].sort());
});

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

const PREX_HEADER = ['Fecha', 'Descripción', 'Moneda Origen', 'Importe Origen', 'Moneda', 'Importe', 'Estado'];

test('Prex statement splits into per-currency accounts and pairs same-day FX legs', () => {
  const rows = [
    PREX_HEADER,
    ['05/10/2026', 'PREX A PREX Argentina DE Renzo Scuadroni', 'UYU', 497.58, 'UYU', 497.58, 'Confirmado'],
    ['03/10/2026', 'Envío Prex a Prex ARG 11260708', 'UYU', -6619.08, 'UYU', -6619.08, 'Confirmado'],
    ['14/08/2026', 'CAMBIO MONEDA DEBITO', 'USD', -848.92, 'USD', -848.92, 'Confirmado'],
    ['14/08/2026', 'CAMBIO MONEDA CREDITO', 'UYU', 34084, 'UYU', 34084, 'Confirmado'],
    ['14/08/2026', 'Pago de Servicios en Abitab', 'UYU', -11228, 'UYU', -11228, 'Confirmado'],
    ['14/04/2026', 'VENTA BTC', 'USD', 25.21, 'USD', 25.46, 'Confirmado'],
    ['14/04/2026', 'Devolución UY', 'BRL', -7.05, 'BRL', -7.05, 'Confirmado'],
    ['19/01/2026', 'CARGA TRANSFERENCIA BANCARIA / 20487300', 'USD', 500, 'USD', 500, 'Confirmado'],
  ];
  const stmts = parsePrexXlsx(prexWorkbook(rows), 'estado_cuenta_20261007.xlsx');
  assert.deepEqual(stmts.map(s => s.account.id).sort(), ['prex-brl', 'prex-usd', 'prex-uyu']);
  assert.ok(stmts.every(s => s.account.institutionId === 'prex' && s.account.type === 'checking'));
  assert.ok(stmts.every(s => s.file === 'estado_cuenta_20261007.xlsx'));

  const uyu = stmts.find(s => s.account.id === 'prex-uyu')!;
  assert.equal(uyu.account.currency, 'UYU');
  assert.equal(uyu.account.number, undefined, 'the export carries no account number');
  assert.equal(uyu.account.closingBalance, undefined, 'the export carries no balances');
  assert.equal(toISODate(uyu.account.periodFrom!), '2026-08-14', 'period inferred from activity');
  assert.equal(toISODate(uyu.account.periodTo!), '2026-10-05');

  const byDesc = new Map(uyu.transactions.map(t => [t.description, t]));
  assert.equal(byDesc.get('PREX A PREX Argentina DE Renzo Scuadroni')!.kind, 'transfer-in');
  assert.equal(byDesc.get('PREX A PREX Argentina DE Renzo Scuadroni')!.counterparty, 'Renzo Scuadroni');
  assert.equal(byDesc.get('Envío Prex a Prex ARG 11260708')!.kind, 'transfer-out');
  assert.equal(byDesc.get('Envío Prex a Prex ARG 11260708')!.reference, '11260708');
  assert.equal(byDesc.get('Pago de Servicios en Abitab')!.kind, 'other');
  assert.equal(byDesc.get('Pago de Servicios en Abitab')!.amount, -11228);

  const usd = stmts.find(s => s.account.id === 'prex-usd')!;
  const btc = usd.transactions.find(t => t.description === 'VENTA BTC')!;
  assert.equal(btc.kind, 'other');
  assert.equal(btc.amount, 25.46, 'posted amount wins over Importe Origen');
  assert.equal(usd.issues.length, 1);
  assert.equal(usd.issues[0].severity, 'warning');
  assert.match(usd.issues[0].message, /Origin amount differs from posted amount/);
  assert.equal(stmts.find(s => s.account.id === 'prex-brl')!.transactions.length, 1);

  // Same-day CAMBIO MONEDA legs get a synthetic shared reference for consolidation.
  const fxUyu = uyu.transactions.find(t => t.kind === 'fx')!;
  const fxUsd = usd.transactions.find(t => t.kind === 'fx')!;
  assert.equal(fxUyu.reference, 'CAMBIO-2026-08-14');
  assert.equal(fxUsd.reference, 'CAMBIO-2026-08-14');
});

test('a non-Prex workbook routed to the Prex parser fails with a single error issue', () => {
  const rows = [PREX_HEADER.slice(0, 4), ['01/01/2026', 'Something', 10, 0]];
  const [stmt] = parsePrexXlsx(prexWorkbook(rows), 'whatever.xlsx');
  assert.equal(stmt.account.id, 'unknown', 'no account is created for a non-Prex file');
  assert.equal(stmt.transactions.length, 0);
  assert.equal(stmt.issues.length, 1);
  assert.equal(stmt.issues[0].severity, 'error');
  assert.match(stmt.issues[0].message, /does not look like a Prex statement/);
});

test('detects Prex by filename and document creator without disturbing existing rules', () => {
  const buf = prexWorkbook([PREX_HEADER, ['05/10/2026', 'X', 'UYU', 1, 'UYU', 1, 'Confirmado']]);
  assert.equal(detectStatementType('estado_cuenta_20261007.xlsx', buf), 'prex-estado');
  assert.equal(detectStatementType('prex_movimientos.xlsx', buf), 'prex-estado');
  assert.equal(detectStatementType('movimientos_2026.xlsx', buf), 'prex-estado', 'renamed files are found via the embedded creator');
  assert.equal(detectStatementType('estado_de_cuenta.xls', Buffer.alloc(0)), 'itau-estado', 'Itau keeps its two-word convention');
  assert.equal(detectStatementType('umsatz.csv', Buffer.alloc(0)), 'santander-umsatz');
  assert.equal(detectStatementType('CreditCardsMovementsDetail.csv', Buffer.alloc(0)), 'santander-card');
  assert.equal(detectStatementType('notestatement.txt', Buffer.alloc(0)), null);
});

test('Prex FX legs consolidate into matched exchanges; third-party transfers remain items', () => {
  const rows = [
    PREX_HEADER,
    ['05/10/2026', 'PREX A PREX Argentina DE Renzo Scuadroni', 'UYU', 497.58, 'UYU', 497.58, 'Confirmado'],
    ['03/10/2026', 'Envío Prex a Prex ARG 11260708', 'UYU', -6619.08, 'UYU', -6619.08, 'Confirmado'],
    ['14/08/2026', 'CAMBIO MONEDA DEBITO', 'USD', -848.92, 'USD', -848.92, 'Confirmado'],
    ['14/08/2026', 'CAMBIO MONEDA CREDITO', 'UYU', 34084, 'UYU', 34084, 'Confirmado'],
  ];
  const result = consolidate(parsePrexXlsx(prexWorkbook(rows), 'estado_cuenta_20261007.xlsx'));
  assert.equal(result.files.length, 1, 'one physical file is reported once');
  assert.equal(result.exchanges.length, 1);
  const ex = result.exchanges[0];
  assert.equal(ex.matchStatus, 'matched');
  assert.equal(ex.fromCurrency, 'USD');
  assert.equal(ex.toCurrency, 'UYU');
  assert.equal(ex.impliedRate, 34084 / 848.92);
  assert.equal(result.items.length, 2, 'unresolvable third-party transfers stay in the financial view');
  assert.deepEqual(result.items.map(i => i.category).sort(), ['transfer-in', 'transfer-out']);
  assert.ok(result.items.every(i => i.accountLabel.startsWith('Prex cuenta')));
  assert.ok(result.items.every(i => i.category !== 'fx-exchange'));
});

test('re-uploading the same Prex file does not double count transactions', () => {
  const rows = [
    PREX_HEADER,
    ['05/10/2026', 'Pago de Servicios en Abitab', 'UYU', -11228, 'UYU', -11228, 'Confirmado'],
    ['14/08/2026', 'CAMBIO MONEDA DEBITO', 'USD', -848.92, 'USD', -848.92, 'Confirmado'],
    ['14/08/2026', 'CAMBIO MONEDA CREDITO', 'UYU', 34084, 'UYU', 34084, 'Confirmado'],
  ];
  const once = parsePrexXlsx(prexWorkbook(rows), 'estado_cuenta_20261007.xlsx');
  const again = parsePrexXlsx(prexWorkbook(rows), 'estado_cuenta_20261007.xlsx');
  const single = consolidate(once);
  const both = consolidate([...once, ...again]);
  assert.equal(both.items.length, single.items.length);
  assert.equal(both.exchanges.length, single.exchanges.length);
  assert.equal(both.exchanges[0].matchStatus, 'matched');
  assert.equal(both.files.length, 1);
});

test('unpaired CAMBIO MONEDA legs stay out of financial items with a warning', () => {
  const rows = [
    PREX_HEADER,
    ['14/08/2026', 'CAMBIO MONEDA DEBITO', 'USD', -848.92, 'USD', -848.92, 'Confirmado'],
    ['14/08/2026', 'CAMBIO MONEDA CREDITO', 'UYU', 34084, 'UYU', 34084, 'Confirmado'],
    ['14/08/2026', 'CAMBIO MONEDA CREDITO', 'UYU', 999, 'UYU', 999, 'Confirmado'],
  ];
  const stmts = parsePrexXlsx(prexWorkbook(rows), 'estado_cuenta.xlsx');
  // File-level pairing warnings attach to the first statement (prex-usd in sort order).
  const usd = stmts.find(s => s.account.id === 'prex-usd')!;
  assert.ok(usd.issues.some(i => /could not be paired as a single exchange/.test(i.message)));
  assert.ok(stmts.every(s => s.transactions.every(t => t.reference === undefined)), 'no synthetic reference without a unique pair');
  const result = consolidate(stmts);
  assert.equal(result.exchanges.filter(e => e.matchStatus === 'unmatched').length, 3, 'legs remain visible as unmatched FX');
  assert.ok(result.items.every(i => i.category !== 'fx-exchange'));
});
