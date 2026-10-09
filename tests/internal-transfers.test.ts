import assert from 'node:assert/strict';
import { test } from 'node:test';
import { consolidate } from '../server/ingestion/consolidation.ts';
import { DatabaseQueries } from '../server/db/queries.ts';
import { createApp } from '../server/server.ts';
import { AccountRegistry, isOwnAccountNumber } from '../server/ingestion/registry.ts';
import { classifySantanderConcept } from '../server/ingestion/parsers/santanderUmsatz.ts';
import { classifyItauConcept } from '../server/ingestion/parsers/itauEstadoXls.ts';
import { date, setup, statement, txn } from './fixtures.ts';
import type { ParsedStatement, RawTxnKind } from '../server/ingestion/types.ts';

function ownBanks(currency = 'UYU', differentBank = false): ParsedStatement[] {
  const a = statement('a'), b = statement('b');
  a.account.number = '7770001'; b.account.number = '007770002';
  a.account.holder = b.account.holder = 'GARCIA LOPEZ ALEX DANIEL';
  b.account.currency = currency;
  if (differentBank) b.account.institutionId = 'another-bank';
  a.transactions = [txn('a', { description: 'Own debit', kind: 'transfer-out', amount: -40000,
    counterparty: b.account.number, reference: 'DEBIT-ID' })];
  b.transactions = [txn('b', { description: 'Own credit', kind: 'transfer-in',
    amount: currency === 'UYU' ? 40000 : 1000, currency, counterparty: a.account.number, reference: 'CREDIT-ID' })];
  return [a, b];
}

function thirdPartyItau(): ParsedStatement {
  const bank = statement('itau-3142914');
  bank.kind = 'itau-estado';
  bank.fileHash = 'third-party-itau-export';
  bank.account.number = '3142914';
  bank.account.institutionId = 'itau-uy';
  bank.transactions = ['0425741', '4674630', '1449919'].flatMap(number => [-100, 75].map(amount => {
    const concept = `TRASPASO ${amount < 0 ? 'A' : 'DE'} ${number}ILINK`;
    const [kind, counterparty] = classifyItauConcept(concept, '', 'Otro');
    return txn(bank.account.id, { description: concept, amount, kind, counterparty,
      metadata: { raw: { concepto: concept, referencia: '', destino: 'Otro' } } });
  }));
  return bank;
}

test('Itaú iLink counterparties are regular expenses/income, not unmatched owned transfers', () => {
  const bank = thirdPartyItau();
  const other = statement('itau-3142920');
  other.kind = 'itau-estado';
  other.account.institutionId = 'itau-uy';
  other.account.number = '3142920';
  // Coincidental dates/amounts in another owned account cannot establish ownership.
  other.transactions = [txn(other.account.id, { kind: 'transfer-in', amount: 100, counterparty: '9999999' })];
  const registry = AccountRegistry.from([bank, other]);
  for (const number of ['0425741', '4674630', '1449919']) {
    assert.equal(isOwnAccountNumber(number), false);
    assert.equal(registry.isOwnCounterparty(number), false);
  }
  const r = consolidate([bank, other]);
  assert.equal(r.transfers.length + r.exchanges.length, 0);
  assert.equal(r.items.length, 7);
  assert.equal(r.items.filter(t => t.category === 'transfer-out').reduce((sum, t) => sum + t.amount, 0), -300);
  assert.equal(r.items.filter(t => t.category === 'transfer-in').reduce((sum, t) => sum + t.amount, 0), 325);
  // Known owned destinations still reconcile, even when that statement is missing.
  bank.transactions.push(txn(bank.account.id, { kind: 'transfer-out', amount: -50, counterparty: '001200769690' }));
  const owned = consolidate([bank]);
  assert.equal(owned.items.length, 6);
  assert.equal(owned.transfers.length, 1);
  assert.equal(owned.transfers[0].toAccountId, 'santander-001200769690');
  assert.equal(owned.transfers[0].matchStatus, 'unmatched');
});

test('startup restores third-party Itaú expenses/income and historical reports while preserving audit/manual data', async () => {
  const { q, sql } = setup();
  try {
    const bank = thirdPartyItau();
    const legacy = consolidate([bank]);
    // Reproduce the previous false ownership assumption in the immutable snapshot.
    legacy.transfers = legacy.items.map(item => ({
      id: `old-${item.id}`, kind: 'internal', matchStatus: 'unmatched',
      fromAccountId: item.amount < 0 ? item.accountId : undefined,
      fromAccountLabel: item.amount < 0 ? item.accountLabel : 'Other Itau account',
      fromAmount: item.amount < 0 ? -item.amount : undefined,
      fromCurrency: item.amount < 0 ? item.currency : undefined,
      fromDate: item.amount < 0 ? item.date : undefined,
      fromDescription: item.amount < 0 ? item.description : undefined,
      toAccountId: item.amount > 0 ? item.accountId : undefined,
      toAccountLabel: item.amount > 0 ? item.accountLabel : 'Other Itau account',
      toAmount: item.amount > 0 ? item.amount : undefined,
      toCurrency: item.amount > 0 ? item.currency : undefined,
      toDate: item.amount > 0 ? item.date : undefined,
      toDescription: item.amount > 0 ? item.description : undefined,
      sourceFiles: item.sourceFiles,
    }));
    legacy.items = [];
    q.saveConsolidation(legacy, [bank]);
    q.saveTransaction({ id: 'manual-itau', accountId: bank.account.id, date: date('2026-09-10'), description: 'Manual expense',
      amount: -5, currency: 'UYU', source: 'manual-entry', importedAt: new Date() });
    const frozen = JSON.stringify(q.getConsolidated(legacy.runId));
    sql.exec('DELETE FROM transactions WHERE reconciled = 1');
    sql.prepare('UPDATE consolidation_state SET result_json = ?, reconciliation_version = 2').run(JSON.stringify(legacy));
    const reopened = new DatabaseQueries(sql);
    const app = createApp(reopened);
    const transactions = await (await app.request('/api/transactions')).json();
    assert.equal(transactions.length, 7);
    assert.equal(transactions.reduce((sum: number, t: { amount: number }) => sum + t.amount, 0), -80);
    assert.ok(transactions.some((t: { id: string }) => t.id === 'manual-itau'));
    for (const route of ['/api/statements/consolidated', `/api/consolidation/runs/${legacy.runId}/report`]) {
      const report = await (await app.request(route)).json();
      assert.equal(report.items.length, 6);
      assert.equal(report.transfers.length + report.exchanges.length, 0);
    }
    assert.equal(JSON.stringify(reopened.getConsolidated(legacy.runId)), frozen);
    assert.equal(reopened.getConsolidationRuns().length, 1);
    const current = JSON.stringify(reopened.getConsolidated());
    assert.equal(JSON.stringify(new DatabaseQueries(sql).getConsolidated()), current);

    // A different export with the same filename must not leak into the old run.
    const later = thirdPartyItau();
    later.fileHash = 'later-itau-export';
    later.transactions = [txn(bank.account.id, { description: 'Later purchase', amount: -123 })];
    q.saveConsolidation(consolidate([later]), [later]);
    const report = q.getConsolidatedReport(legacy.runId)!;
    assert.equal(report.items.length, 6);
    assert.ok(report.items.every(t => t.description !== 'Later purchase'));
  } finally { sql.close(); }
});

test('own transfers across and within banks never enter financial items, in either currency direction', () => {
  for (const differentBank of [false, true]) for (const currency of ['UYU', 'USD']) for (const reversed of [false, true]) {
    const sources = ownBanks(currency, differentBank);
    if (reversed) sources.forEach(s => s.transactions[0].amount *= -1);
    for (const input of [sources, [...sources].reverse()]) {
      const r = consolidate(input);
      assert.deepEqual(r.items, []);
      if (currency === 'UYU') {
        assert.equal(r.transfers.length, 1);
        assert.equal(r.transfers[0].matchStatus, 'matched');
        assert.equal(r.transfers[0].fromAccountId, reversed ? 'b' : 'a');
        assert.deepEqual(r.transfers[0].sourceFiles.sort(), ['a.csv', 'b.csv']);
      } else {
        assert.equal(r.exchanges.length, 1);
        assert.equal(r.exchanges[0].matchStatus, 'matched');
        assert.equal(r.exchanges[0].impliedRate, reversed ? 40 : 0.025);
      }
    }
  }
});

test('FX-marked legs reconcile with transfer-marked legs, even without matching bank references', () => {
  for (const kinds of [['fx', 'transfer-in'], ['transfer-out', 'fx'], ['fx', 'fx']] as RawTxnKind[][]) {
    const sources = ownBanks('USD');
    sources.forEach((s, i) => s.transactions[0].kind = kinds[i]);
    const r = consolidate(sources);
    assert.equal(r.exchanges.length, 1);
    assert.equal(r.exchanges[0].matchStatus, 'matched');
    assert.equal(r.items.length, 0);
  }
});

test('unpaired owned principal stays excluded and shows the missing side, including credit-only FX', () => {
  for (const currency of ['UYU', 'USD']) for (const index of [0, 1]) {
    const sources = ownBanks(currency);
    const r = consolidate([sources[index], { ...sources[1 - index], transactions: [] }]);
    assert.equal(r.items.length, 0);
    const movements = [...r.transfers, ...r.exchanges];
    assert.equal(movements.length, 1);
    assert.equal(movements[0].matchStatus, 'unmatched');
    assert.equal(movements[0].fromAmount, index === 0 ? 40000 : undefined);
    assert.equal(movements[0].toAmount, index === 1 ? currency === 'USD' ? 1000 : 40000 : undefined);
  }
});

test('formatted/discovered account numbers match exactly, never inside longer identifiers', () => {
  assert.equal(isOwnAccountNumber('Cuenta 001-200-769690'), true);
  assert.equal(isOwnAccountNumber('1200769690'), true);
  assert.equal(isOwnAccountNumber('99314291488'), false);
  const registry = AccountRegistry.from(ownBanks());
  assert.equal(registry.isOwnCounterparty('7770002'), true);
  assert.equal(registry.isOwnCounterparty('ALEX GARCIA'), true);
  assert.equal(registry.isOwnCounterparty('ALEX'), false);
  assert.equal(registry.isOwnCounterparty('ALEX GARCIA 9999999'), false);
});

test('name-based Santander wires match generic Itau credits from archived raw fields; bank fees stay expenses', () => {
  const [santander, itau] = ownBanks('UYU', true);
  santander.kind = 'santander-umsatz';
  itau.kind = 'itau-estado';
  const principal = 'DEBITO OPERACION EN BANCA DIGITAL 684170TT55 TRF. PLAZA- ALEX GARCIA';
  const charge = 'TRANSFERENCIA ENVIADA 684182TT55 TRF. PLAZA- ALEX GARCIA';
  santander.transactions = [txn('a', { description: principal, kind: 'transfer-out', amount: -7000, reference: 'TT55',
    metadata: { raw: { concepto: principal } } }),
    txn('a', { description: charge, kind: 'transfer-out', amount: -1.9, reference: 'TT55', metadata: { raw: { concepto: charge } } })];
  const credit = 'CRE. CAMBIOSOP....800156';
  itau.transactions = [txn('b', { description: credit, kind: 'other', amount: 7000, metadata: { raw: { concepto: credit } } })];
  const r = consolidate([santander, itau]);
  assert.deepEqual(r.items.map(t => [t.category, t.amount]), [['fee', -1.9]]);
  assert.equal(r.transfers[0].matchStatus, 'matched');
  assert.equal(r.transfers[0].toAmount, 7000);
  assert.equal(consolidate([santander]).transfers[0].matchStatus, 'unmatched');
  assert.deepEqual(classifySantanderConcept('TRASPASO CON LA CUENTA N. 001200769690', -10), ['transfer-out', '001200769690']);
});

test('third-party transfers, matching amounts, and owner names in memos cannot produce internal matches', () => {
  const [a, b] = ownBanks();
  a.transactions[0].counterparty = '9999999';
  a.transactions[0].reference = 'ALEX GARCIA';
  a.transactions[0].description = 'Payment memo ALEX GARCIA';
  b.transactions[0].counterparty = '8888888';
  const r = consolidate([a, b]);
  assert.equal(r.items.length, 2);
  assert.equal(r.transfers.length + r.exchanges.length, 0);
  // Even one proven owned leg must not consume an explicitly external credit.
  a.transactions[0].counterparty = b.account.number;
  const mixed = consolidate([a, b]);
  assert.equal(mixed.items.length, 1);
  assert.equal(mixed.items[0].amount, 40000);
  assert.equal(mixed.transfers[0].matchStatus, 'unmatched');
});

test('ambiguous FX and contradictory references stay unmatched rather than guessing a rate', () => {
  const [a, b] = ownBanks('USD');
  b.transactions.push({ ...b.transactions[0], amount: 2000 });
  const ambiguous = consolidate([a, b]);
  // Neither candidate may steal the debit merely by being processed second.
  assert.equal(ambiguous.items.length, 0);
  assert.equal(ambiguous.exchanges.filter(e => e.matchStatus === 'matched').length, 0);
  a.transactions[0].counterparty = b.transactions[0].counterparty = undefined;
  a.transactions[0].kind = b.transactions[0].kind = 'fx';
  b.transactions.pop();
  assert.equal(consolidate([a, b]).exchanges.filter(e => e.matchStatus === 'matched').length, 0);
});

test('separate uploads and startup upgrade repair report APIs without altering history or manual rows', async () => {
  const { q, sql } = setup();
  try {
    const sources = ownBanks('USD');
    q.saveConsolidation(consolidate([sources[0]]), [sources[0]]);
    const first = q.getConsolidated()!;
    const history = JSON.stringify(q.getConsolidated(first.runId));
    q.saveConsolidation(consolidate([sources[1]]), [sources[1]]);
    assert.equal(q.getConsolidated()!.exchanges[0].matchStatus, 'matched');
    assert.equal(q.getTransactions().length, 0);
    q.saveTransaction({ id: 'manual', accountId: 'a', date: date('2026-09-10'), description: 'Manual income',
      amount: 5, currency: 'UYU', category: 'income', source: 'manual-entry', importedAt: new Date() });
    // Simulate the old current view, then reopen like API startup.
    sql.prepare(`INSERT INTO transactions (id, account_id, date, description, amount, currency, source, imported_at, reconciled)
      VALUES ('old-principal', 'a', ?, 'Own debit', -40000, 'UYU', 'file-upload', ?, 1)`)
      .run(date('2026-09-10').toISOString(), new Date().toISOString());
    sql.exec('UPDATE consolidation_state SET reconciliation_version = 0');
    const reopened = new DatabaseQueries(sql);
    const app = createApp(reopened);
    for (const route of ['/api/transactions', '/api/accounts/a/transactions']) {
      const response = await app.request(route);
      assert.deepEqual((await response.json()).map((t: { id: string }) => t.id), ['manual']);
    }
    const current = await (await app.request('/api/statements/consolidated')).json();
    assert.equal(current.items.length, 0);
    assert.equal(current.exchanges[0].matchStatus, 'matched');
    assert.equal(JSON.stringify(reopened.getConsolidated(first.runId)), history);
    assert.equal(reopened.getConsolidationRuns().length, 2);
    const after = JSON.stringify(reopened.getConsolidated());
    assert.equal(JSON.stringify(new DatabaseQueries(sql).getConsolidated()), after, 'upgrade is idempotent');
  } finally { sql.close(); }
});

test('historical reports exclude newly identified principal without changing immutable audit snapshots', async () => {
  const { q, sql } = setup();
  try {
    const sources = ownBanks('USD');
    sources[0].transactions.push(txn('a', { kind: 'fee', description: 'Bank fee', amount: -2 }));
    const legacy = consolidate(sources);
    legacy.items = sources.flatMap(s => s.transactions.map(t => ({
      ...t, id: `legacy-${s.account.id}-${t.description}`, accountLabel: s.account.name,
      category: t.kind === 'fee' ? 'fee' as const : t.amount < 0 ? 'expense' as const : 'income' as const,
      sourceFiles: [s.file],
    })));
    q.saveConsolidation(legacy, sources);
    const frozen = JSON.stringify(q.getConsolidated(legacy.runId));
    const app = createApp(q);
    const report = await (await app.request(`/api/consolidation/runs/${legacy.runId}/report`)).json();
    assert.deepEqual(report.items.map((t: { description: string; amount: number }) => [t.description, t.amount]), [['Bank fee', -2]]);
    assert.equal(JSON.stringify(q.getConsolidated(legacy.runId)), frozen);
    assert.equal((await (await app.request(`/api/consolidation/runs/${legacy.runId}`)).json()).items.length, 3);
    assert.equal((await app.request('/api/consolidation/runs/missing/report')).status, 404);
  } finally { sql.close(); }
});
