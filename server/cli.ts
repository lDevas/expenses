#!/usr/bin/env node

import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import { startServer } from './server.ts';
import { openStatementsDatabase, runConsolidationFromPaths } from './pipeline.ts';
import type { ConsolidatedResult, ParsedStatement } from './ingestion/types.ts';

const API_URL = process.env.API_URL || 'http://localhost:3456';

const program = new Command();

program
  .name('seville')
  .description('Manual bank and broker statement consolidation')
  .version('0.1.0');

// ─── Setup Commands ───

program
  .command('init')
  .description('Initialize the database and seed default institutions')
  .action(async () => {
    const res = await fetch(`${API_URL}/api/health`);
    if (!res.ok) {
      console.log('🚀 Starting local server for initialization...');
      startServer();
      await new Promise(r => setTimeout(r, 2000));
    }
    
    console.log('📁 Initializing database...');
    console.log('✅ Database initialized at ./data/expenses.db');
    console.log('🏦 Seeded 5 default institutions.');
    console.log('\nNext steps:');
    console.log('  Upload statement files in the Ingestion tab, or run: seville consolidate <files...>');
  });

// ─── Upload coverage ───

program
  .command('status')
  .description('Show per-account uploaded date ranges and possible gaps')
  .action(async () => {
    const res = await fetch(`${API_URL}/api/accounts/upload-ranges`);
    if (!res.ok) throw new Error(`Could not load upload coverage (HTTP ${res.status})`);
    const accounts = await res.json();
    console.log('Seville — Upload Coverage');
    if (!accounts.length) console.log('No uploaded accounts yet.');
    for (const account of accounts) {
      console.log(`\n${account.institutionName} — ${account.accountName} (${account.currency})`);
      console.log(`  Uploaded through: ${account.maxDate ?? 'unknown'}; ${account.fileCount} unique files tracked`);
      console.log(`  Last upload: ${account.lastUploadAt ?? 'never'}`);
      for (const gap of account.gaps) console.log(`  Possible gap: ${gap.from} → ${gap.to} (${gap.days} days)`);
    }
  });

// ─── Transaction Commands ───

program
  .command('transactions')
  .description('List ingested transactions')
  .option('--account <id>', 'Filter by account ID')
  .option('--from <date>', 'Start date (YYYY-MM-DD)')
  .option('--to <date>', 'End date (YYYY-MM-DD)')
  .option('--source <type>', 'Filter by source (ai-ingestion, file-upload, manual-entry)')
  .action(async (opts) => {
    const query = new URLSearchParams();
    if (opts.account) query.set('account', opts.account);
    if (opts.from) query.set('from', opts.from);
    if (opts.to) query.set('to', opts.to);
    if (opts.source) query.set('source', opts.source);
    
    const res = await fetch(`${API_URL}/api/transactions?${query}`);
    const transactions = await res.json();
    
    if (transactions.length === 0) {
      console.log('  No transactions found.');
      return;
    }
    
    console.log(`\n  ${transactions.length} transactions found:`);
    console.log('─'.repeat(60));
    console.log('  Date        | Description                          | Amount     | Source');
    console.log('─'.repeat(60));
    
    for (const txn of transactions) {
      const date = new Date(txn.date).toLocaleDateString();
      const desc = (txn.description || '').substring(0, 35).padEnd(35);
      const amount = (txn.amount / 100).toFixed(2).padStart(10);
      const source = txn.source;
      console.log(`  ${date} | ${desc} | ${amount} | ${source}`);
    }
    
    console.log('─'.repeat(60));
  });

// ─── Account Commands ───

program
  .command('accounts')
  .description('List all accounts')
  .action(async () => {
    const res = await fetch(`${API_URL}/api/accounts`);
    const accounts = await res.json();
    
    console.log(`\n  ${accounts.length} accounts:`);
    for (const acc of accounts) {
      console.log(`  ${acc.name} — Balance: ${acc.balance} ${acc.currency} (${acc.type})`);
    }
  });

// ─── Statement Consolidation Commands ───

program
  .command('consolidate <files...>')
  .description('Parse + consolidate statement files end-to-end and print the lists (no server needed)')
  .option('--db <path>', 'SQLite path to persist the run (default: scratch DB in the temp dir)')
  .action(async (files: string[], opts: { db?: string }) => {
    for (const f of files) {
      if (!fs.existsSync(f)) {
        console.error(`❌ File not found: ${f}`);
        process.exitCode = 1;
        return;
      }
    }

    const dbPath = opts.db || path.join(path.resolve('.'), 'data', `consolidate-${Date.now()}.db`);
    console.log(`📁 Database: ${dbPath}`);
    const queries = openStatementsDatabase(dbPath);
    const { result, statements } = await runConsolidationFromPaths(files, queries);
    printConsolidation(result, statements);
  });

function printConsolidation(result: ConsolidatedResult, statements: ParsedStatement[]): void {
  console.log(`\n${'═'.repeat(100)}`);
  console.log(`  Consolidation run ${result.runId}`);
  console.log(`${'═'.repeat(100)}`);

  console.log('\n  Files:');
  for (const s of statements) {
    const errors = s.issues.filter((i) => i.severity === 'error').length;
    const warnings = s.issues.filter((i) => i.severity === 'warning').length;
    const flag = errors > 0 ? '❌' : warnings > 0 ? '⚠️ ' : '✅ ';
    const notes = [
      errors > 0 ? `${errors} error(s)` : '',
      warnings > 0 ? `${warnings} warning(s)` : '',
    ].filter(Boolean).join(', ');
    console.log(`   ${flag} ${s.file} [${s.kind}] — ${s.transactions.length} txns, ${s.positions.length} positions, ${s.realized.length} realized${notes ? ` (${notes})` : ''}`);
  }

  console.log(
    `\n  Totals: ${result.items.length} items, ${result.transfers.length} transfers, ${result.exchanges.length} exchanges, ${result.positions.length} positions, ${result.realized.length} realized, ${result.issues.length} issues`,
  );

  const money = (n: number | undefined, ccy?: string) =>
    n === undefined ? '—' : `${n < 0 ? '-' : '+'}${Math.abs(n).toFixed(2)}${ccy ? ` ${ccy}` : ''}`;
  const iso = (d: Date | undefined) => (d ? d.toISOString().slice(0, 10) : '--------');

  console.log(`\n── Items (${result.items.length})`);
  for (const it of result.items) {
    console.log(
      `  ${iso(it.date)}  ${it.accountLabel.slice(0, 26).padEnd(26)}  ${it.category.padEnd(18)}  ${money(it.amount, it.currency).padStart(14)}  ${it.description.slice(0, 44)}`,
    );
  }

  console.log(`\n── Transfers (${result.transfers.length})`);
  for (const t of result.transfers) {
    const from = t.fromAccountId ? `${t.fromAccountLabel} ${money(t.fromAmount, t.fromCurrency)}` : `${t.fromAccountLabel} (?)`;
    const to = t.toAccountId ? `${t.toAccountLabel} ${money(t.toAmount, t.toCurrency)}` : `${t.toAccountLabel} (?)`;
    console.log(
      `  [${t.kind}] ${t.matchStatus.padEnd(9)}  ${iso(t.fromDate)} → ${iso(t.toDate)}  ${from.slice(0, 44)} ⇒ ${to.slice(0, 44)}${t.impliedRate ? `  @ ${t.impliedRate}` : ''}`,
    );
  }

  console.log(`\n── FX exchanges (${result.exchanges.length})`);
  for (const e of result.exchanges) {
    console.log(
      `  ${e.matchStatus.padEnd(9)}  ${iso(e.date)}  ${e.accountLabel.slice(0, 40)}  ${e.fromAmount !== undefined ? `${e.fromAmount.toFixed(2)} ${e.fromCurrency} → ${e.toAmount !== undefined ? e.toAmount.toFixed(2) + ' ' + (e.toCurrency ?? '') : '?'}` : ''}${e.impliedRate ? `  @ ${e.impliedRate}` : ''}`,
    );
  }

  console.log(`\n── Positions (${result.positions.length})`);
  for (const p of result.positions) {
    console.log(
      `  ${iso(p.snapshotDate)}  ${p.accountLabel.slice(0, 26).padEnd(26)}  ${(p.symbol ?? '').padEnd(8)}  qty ${String(p.qty).padStart(10)}  cost ${(p.costBasis ?? 0).toFixed(2).padStart(12)}  value ${(p.value ?? 0).toFixed(2).padStart(12)}  uPL ${(p.unrealizedPl ?? 0).toFixed(2).padStart(12)} ${p.currency}`,
    );
  }

  console.log(`\n── Realized P/L (${result.realized.length})`);
  for (const r of result.realized) {
    console.log(
      `  ${iso(r.date)}  ${r.accountLabel.slice(0, 26).padEnd(26)}  ${(r.symbol ?? '').padEnd(8)}  qty ${String(r.qty ?? '?').padStart(10)}  proceeds ${(r.proceeds ?? 0).toFixed(2).padStart(12)}  P/L ${money(r.realizedPl, r.currency)}`,
    );
  }

  console.log(`\n── Issues (${result.issues.length})`);
  for (const i of result.issues) {
    const where = [i.sheet, i.row !== undefined ? `row ${i.row}` : '', i.field].filter(Boolean).join(', ');
    console.log(`  [${i.severity}] ${i.file}${where ? ` (${where})` : ''} — ${i.message}`);
  }
  console.log('');
}

// ─── Run ───

program.parse();
