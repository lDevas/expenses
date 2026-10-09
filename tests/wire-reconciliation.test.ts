import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as XLSX from 'xlsx';
import { consolidate } from '../server/ingestion/consolidation.ts';
import { classifyItauConcept, parseItauEstado } from '../server/ingestion/parsers/itauEstadoXls.ts';
import { DatabaseQueries } from '../server/db/queries.ts';
import { createApp } from '../server/server.ts';
import { date, pairedStatements, setup, statement, txn } from './fixtures.ts';

function wireStatements(withdrawal = false, named = false) {
  const bank = statement('bank');
  bank.kind = 'itau-estado';
  bank.account.currency = 'USD';
  const description = named ? 'Wire INTERACTIVE BROKERS' : withdrawal ? 'CRE. CAMBIOSOP....591829' : 'DEB. CAMBIOSST....591829';
  bank.transactions = [txn('bank', { currency: 'USD', amount: withdrawal ? 9970 : -10000,
    kind: withdrawal ? 'transfer-in' : 'transfer-out', description,
    metadata: named ? undefined : { raw: { concepto: description } } })];
  const broker = statement('ibkr');
  broker.kind = 'ibkr-statement';
  broker.account = { ...broker.account, type: 'investment', currency: 'USD', institutionName: 'Interactive Brokers' };
  broker.transactions = [txn('ibkr', { currency: 'USD', kind: withdrawal ? 'withdrawal' : 'deposit',
    amount: withdrawal ? -10000 : 9970, description: withdrawal ? 'Broker withdrawal' : 'Broker deposit', date: date('2026-09-12') })];
  return [bank, broker];
}

test('Itau wire codes parse as transfers, not FX, while commissions and actual exchanges keep their semantics', () => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['Nombre', 'Tipo de cuenta', 'Moneda', 'Nro de cuenta'],
    ['Test Holder', 'Caja de ahorro', 'Dólares', '3142920'],
    ['Fecha', 'Concepto', 'Débito', 'Crédito', 'Saldo', 'Referencia', 'Destino'],
    ['10/09/2026', 'DEB. CAMBIOSST....591829', 10000, '', 20000, '', 'Otro'],
    ['10/09/2026', 'DEB. CAMBIOSCOM....591829', 10, '', 19990, '', 'Otro'],
    ['11/09/2026', 'CRE. CAMBIOSOP....591830', '', 9970, 29960, '', 'Otro'],
    ['11/09/2026', 'DEB. CAMBIO', 100, '', 29860, 'CAMBIO', 'Otro'],
  ]), 'Estado');
  const parsed = parseItauEstado(XLSX.write(workbook, { type: 'buffer', bookType: 'xls' }), 'itau.xls');
  assert.deepEqual(parsed.issues, []);
  assert.deepEqual(parsed.transactions.map(row => [row.kind, row.amount]),
    [['transfer-out', -10000], ['fee', -10], ['transfer-in', 9970], ['fx', -100]]);
  assert.deepEqual(classifyItauConcept('DEB. CAMBIOSST....591829', '', ''), ['transfer-out', undefined]);
});

test('generic and named broker wires allow fee shortfalls in either direction, preserving both amounts and separate fees', () => {
  for (const withdrawal of [false, true]) for (const named of [false, true]) {
    const [bank, broker] = wireStatements(withdrawal, named);
    bank.transactions.push(txn('bank', { currency: 'USD', amount: -10, kind: 'fee',
      description: 'DEB. CAMBIOSCOM....591829', metadata: { raw: { concepto: 'DEB. CAMBIOSCOM....591829' } } }));
    const before = JSON.stringify([bank, broker]);
    const result = consolidate([bank, broker]);
    assert.equal(JSON.stringify([bank, broker]), before, 'matching never changes source statements');
    assert.equal(result.transfers.length, 1);
    assert.equal(result.transfers[0].matchStatus, 'matched');
    assert.equal(result.transfers[0].fromAmount, 10000);
    assert.equal(result.transfers[0].toAmount, 9970);
    assert.equal(result.transfers[0].fromAccountId, withdrawal ? 'ibkr' : 'bank');
    assert.equal(result.transfers[0].toAccountId, withdrawal ? 'bank' : 'ibkr');
    assert.deepEqual(result.transfers[0].sourceFiles.sort(), ['bank.csv', 'ibkr.csv']);
    assert.deepEqual(result.items.map(row => [row.category, row.amount]), [['fee', -10]]);
    assert.deepEqual(result.exchanges, []);
    assert.deepEqual(result.issues, []);
  }
});

test('fee allowance respects its percentage/cap and rejects extra receipts or out-of-window wires', () => {
  for (const [sent, received, matched] of [
    [10000, 10000, true], [10000, 9900, true], [10000, 9899.99, false],
    [100000, 99900, true], [100000, 99899.99, false], [10000, 10030, false],
  ] as const) {
    const sources = wireStatements();
    sources[0].transactions[0].amount = -sent;
    sources[1].transactions[0].amount = received;
    assert.equal(consolidate(sources).transfers[0].matchStatus, matched ? 'matched' : 'unmatched');
  }
  const sources = wireStatements();
  sources[1].transactions[0].date = date('2026-09-13');
  assert.equal(consolidate(sources).transfers[0].matchStatus, 'unmatched');
});

test('generic local-bank transfers are not automatically treated as broker funding or FX', () => {
  const [bank] = wireStatements();
  const alone = consolidate([bank]);
  assert.deepEqual(alone.transfers, []);
  assert.deepEqual(alone.exchanges, []);
  assert.equal(alone.items[0].amount, -10000);
  const sources = wireStatements();
  sources[0].transactions[0].metadata = undefined;
  sources[0].transactions[0].counterparty = '9999999';
  const thirdParty = consolidate(sources);
  assert.equal(thirdParty.transfers[0].matchStatus, 'unmatched');
  assert.equal(thirdParty.items[0].amount, -10000);
});

test('generic wire ambiguity is resolved only by stronger named evidence, never statement/row order', () => {
  const [bank, ibkr] = wireStatements();
  bank.transactions.push({ ...bank.transactions[0], description: 'DEB. CAMBIOSST....591830',
    metadata: { raw: { concepto: 'DEB. CAMBIOSST....591830' } }, date: date('2026-09-11') });
  for (const sources of [[bank, ibkr], [ibkr, bank]]) {
    const result = consolidate(sources);
    assert.equal(result.transfers[0].matchStatus, 'unmatched');
    assert.equal(result.items.length, 2);
  }
  bank.transactions.reverse();
  assert.equal(consolidate([bank, ibkr]).transfers[0].matchStatus, 'unmatched');
  bank.transactions.pop();
  const etoro = statement('etoro');
  etoro.account = { ...etoro.account, type: 'investment', currency: 'USD', institutionName: 'eToro' };
  etoro.transactions = [txn('etoro', { ...ibkr.transactions[0], accountId: 'etoro' })];
  assert.ok(consolidate([bank, ibkr, etoro]).transfers.every(row => row.matchStatus === 'unmatched'));
  bank.transactions.push(txn('bank', { kind: 'transfer-out', amount: -9990, currency: 'USD', description: 'Wire ETORO' }));
  const proven = consolidate([bank, ibkr, etoro]);
  assert.ok(proven.transfers.every(row => row.matchStatus === 'matched'));
  assert.equal(proven.transfers.find(row => row.toAccountId === 'etoro')!.fromDescription, 'Wire ETORO');
  assert.match(proven.transfers.find(row => row.toAccountId === 'ibkr')!.fromDescription!, /CAMBIOSST/);
});

test('named duplicate wires stay ambiguous and non-principal/card rows cannot be consumed', () => {
  const sources = wireStatements(false, true);
  sources[1].transactions.push({ ...sources[1].transactions[0] });
  assert.ok(consolidate(sources).transfers.every(row => row.matchStatus === 'unmatched'));
  for (const kind of ['fee', 'purchase', 'card-payment'] as const) {
    const pair = wireStatements(false, true);
    pair[0].transactions[0].kind = kind;
    assert.equal(consolidate(pair).transfers[0].matchStatus, 'unmatched');
  }
  const card = wireStatements(false, true);
  card[0].account.type = 'credit';
  assert.equal(consolidate(card).transfers[0].matchStatus, 'unmatched');
});

test('generic cross-currency wires require a matched FX rate and preserve original currencies', () => {
  const [fxBank, fxUsd] = pairedStatements();
  fxBank.transactions = fxBank.transactions.filter(row => row.kind === 'fx');
  const [bank, broker] = wireStatements();
  bank.account.id = 'wire-bank';
  bank.account.currency = 'UYU';
  bank.transactions[0] = { ...bank.transactions[0], accountId: 'wire-bank', amount: -398800, currency: 'UYU' };
  broker.transactions[0].amount = 10000;
  assert.equal(consolidate([bank, broker]).transfers[0].matchStatus, 'unmatched');
  const matched = consolidate([fxBank, fxUsd, bank, broker]).transfers[0];
  assert.equal(matched.matchStatus, 'matched');
  assert.equal(matched.fromCurrency, 'UYU');
  assert.equal(matched.toCurrency, 'USD');
  assert.equal(matched.fromAmount, 398800);
  assert.equal(matched.toAmount, 10000);
});

test('archived wire sources reconcile across uploads and version-one startup repair preserves audit history', async () => {
  const { q, sql } = setup();
  try {
    const [bank, broker] = wireStatements();
    bank.transactions[0].kind = 'fx'; // Old Itau parser misclassified this code.
    const first = consolidate([bank]);
    q.saveConsolidation(first, [bank]);
    const frozen = JSON.stringify(q.getConsolidated(first.runId));
    q.saveConsolidation(consolidate([broker]), [broker]);
    assert.equal(q.getConsolidated()!.transfers[0].matchStatus, 'matched');
    assert.equal(q.getTransactions().length, 0);
    // Simulate a previously saved view and materialized expense from version 1.
    const current = q.getConsolidated()!;
    const old = { ...current, transfers: current.transfers.map(row => ({ ...row, matchStatus: 'unmatched' })) };
    sql.prepare('UPDATE consolidation_state SET result_json = ?, reconciliation_version = 1').run(JSON.stringify(old));
    sql.prepare(`INSERT INTO transactions (id, account_id, date, description, amount, currency, source, imported_at, reconciled)
      VALUES ('old-wire', 'bank', ?, 'DEB. CAMBIOSST....591829', -10000, 'USD', 'file-upload', ?, 1)`)
      .run(date('2026-09-10').toISOString(), new Date().toISOString());
    q.saveTransaction({ id: 'manual', accountId: 'bank', date: date('2026-09-10'), description: 'Manual income',
      amount: 5, currency: 'USD', category: 'income', source: 'manual-entry', importedAt: new Date() });
    const reopened = new DatabaseQueries(sql);
    const app = createApp(reopened);
    const response = await app.request('/api/statements/consolidated');
    const report = await response.json();
    assert.equal(report.transfers[0].matchStatus, 'matched');
    assert.equal(report.transfers[0].fromAmount, 10000);
    assert.equal(report.transfers[0].toAmount, 9970);
    assert.deepEqual(reopened.getTransactions().map(row => row.id), ['manual']);
    assert.equal(JSON.stringify(reopened.getConsolidated(first.runId)), frozen);
    assert.equal(reopened.getConsolidationRuns().length, 2);
    const after = JSON.stringify(reopened.getConsolidated());
    assert.equal(JSON.stringify(new DatabaseQueries(sql).getConsolidated()), after, 'startup repair is idempotent');
  } finally { sql.close(); }
});

test('historical financial projections exclude proven broker principal without rewriting snapshots', () => {
  const { q, sql } = setup();
  try {
    const [bank, broker] = wireStatements(false, true);
    const oldRun = consolidate([bank, broker]);
    oldRun.items = [{ ...bank.transactions[0], id: 'old-bank-wire', accountLabel: bank.account.name,
      category: 'expense', sourceFiles: [bank.file] }];
    q.saveConsolidation(oldRun, [bank, broker]);
    const frozen = JSON.stringify(q.getConsolidated(oldRun.runId));
    assert.deepEqual(q.getConsolidatedReport(oldRun.runId)!.items, []);
    assert.equal(JSON.stringify(q.getConsolidated(oldRun.runId)), frozen);
  } finally { sql.close(); }
});
