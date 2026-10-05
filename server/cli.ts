#!/usr/bin/env node

import { Command } from 'commander';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { startServer } from './server.ts';
import { openStatementsDatabase, runConsolidationFromPaths } from './pipeline.ts';
import type { ConsolidatedResult, ParsedStatement } from './ingestion/types.ts';

const API_URL = process.env.API_URL || 'http://localhost:3456';

const program = new Command();

program
  .name('seville')
  .description('AI-powered bank statement ingestion system')
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
    console.log('✅ Database initialized at ~/.seville/data/seville.db');
    console.log('🏦 Seeded 5 default institutions.');
    console.log('\nNext steps:');
    console.log('  1. Export browser sessions: seville setup-cookies <institution-id>');
    console.log('  2. Run ingestion: seville ingest <institution-id>');
  });

program
  .command('setup-cookies <institutionId>')
  .description('Export browser cookies for a specific institution (one-time setup)')
  .option('--browser <name>', 'Browser to use', 'chrome')
  .action(async (institutionId: string) => {
    const res = await fetch(`${API_URL}/api/sessions/${institutionId}/export`, { method: 'POST' });
    const data = await res.json();
    
    if (data.error) {
      console.error(`❌ ${data.error}`);
      return;
    }
    
    console.log(`✅ Session exported for ${institutionId}`);
    console.log(`   Cookies saved to ~/.seville/cookies/${institutionId}.json`);
    console.log(`   You can now run: seville ingest ${institutionId}`);
  });

// ─── Ingestion Commands ───

program
  .command('ingest <institutionId>')
  .description('Run AI ingestion for a specific institution or "all"')
  .option('--from <date>', 'Start date (YYYY-MM-DD)')
  .option('--to <date>', 'End date (YYYY-MM-DD)')
  .option('--verbose', 'Show detailed output')
  .action(async (institutionId: string, opts) => {
    const query = new URLSearchParams();
    if (opts.from) query.set('from', opts.from);
    if (opts.to) query.set('to', opts.to);
    
    // If "all", we need to get all institution IDs first
    if (institutionId === 'all') {
      const statusRes = await fetch(`${API_URL}/api/ingest/status`);
      const institutions = await statusRes.json();
      
      for (const inst of institutions) {
        console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
        console.log(`🔄 Ingesting ${inst.name}...`);
        
        const ingestRes = await fetch(`${API_URL}/api/ingest/${inst.id}?${query}`, { method: 'POST' });
        const run = await ingestRes.json();
        
        if (opts.verbose && run.steps) {
          console.log(`   Steps executed: ${run.steps.length}`);
          for (const step of run.steps) {
            const icon = step.result === 'success' ? '✓' : step.result === 'failed' ? '✗' : '~';
            console.log(`   ${icon} [${step.order}] ${step.action}`);
            if (step.message) console.log(`      ${step.message}`);
          }
        }
        
        const icon = run.status === 'success' ? '✅' : run.status === 'partial' ? '⚠️' : '❌';
        console.log(`   ${icon} ${run.status}: ${run.transactionsIngested} transactions ingested`);
        if (run.error) console.log(`   Error: ${run.error}`);
      }
    } else {
      const ingestRes = await fetch(`${API_URL}/api/ingest/${institutionId}?${query}`, { method: 'POST' });
      const run = await ingestRes.json();
      
      if (run.error) {
        console.error(`❌ ${run.error}`);
        return;
      }
      
      if (opts.verbose && run.steps) {
        console.log(`   Steps executed: ${run.steps.length}`);
        for (const step of run.steps) {
          const icon = step.result === 'success' ? '✓' : step.result === 'failed' ? '✗' : '~';
          console.log(`   ${icon} [${step.order}] ${step.action}`);
          if (step.message) console.log(`      ${step.message}`);
        }
      }
      
      const icon = run.status === 'success' ? '✅' : run.status === 'partial' ? '⚠️' : '❌';
      console.log(`${icon} ${run.status}: ${run.transactionsIngested} transactions ingested`);
    }
  });

// ─── Status Commands ───

program
  .command('status')
  .description('Show status of all institutions')
  .action(async () => {
    const res = await fetch(`${API_URL}/api/ingest/status`);
    const institutions = await res.json();
    
    console.log('\n' + '━'.repeat(60));
    console.log('  Seville — Institution Status');
    console.log('━'.repeat(60));
    
    for (const inst of institutions) {
      const statusIcon = inst.status === 'active' ? '🟢' : inst.status === 'error' ? '🔴' : '🟡';
      const lastRun = inst.lastRun;
      const lastRunStatus = lastRun ? lastRun.status : 'never';
      const lastRunCount = lastRun ? lastRun.transactionsIngested : 0;
      
      console.log(`\n  ${statusIcon} ${inst.name}`);
      console.log(`     ID: ${inst.id}`);
      console.log(`     Type: ${inst.type}`);
      console.log(`     Last sync: ${inst.lastSync ? new Date(inst.lastSync).toLocaleDateString() : 'never'}`);
      console.log(`     Last run: ${lastRunStatus} (${lastRunCount} transactions)`);
    }
    
    console.log('\n' + '━'.repeat(60));
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

// ─── Session Commands ───

program
  .command('sessions')
  .description('Manage browser sessions')
  .action(() => {
    // Subcommands
  });

program
  .command('sessions:list')
  .description('List all saved browser sessions')
  .action(async () => {
    const res = await fetch(`${API_URL}/api/sessions`);
    const sessions = await res.json();
    
    if (sessions.length === 0) {
      console.log('  No saved sessions.');
      console.log('  Create one: seville setup-cookies <institution-id>');
      return;
    }
    
    console.log('\n  Saved sessions:');
    for (const sess of sessions) {
      const created = new Date(sess.createdAt).toLocaleDateString();
      const expires = sess.expiresAt ? new Date(sess.expiresAt).toLocaleDateString() : 'never';
      console.log(`  ${sess.institutionId} — Created: ${created}, Expires: ${expires}`);
    }
  });

program
  .command('sessions:clear <institutionId>')
  .description('Clear a saved browser session')
  .action(async (institutionId: string) => {
    const res = await fetch(`${API_URL}/api/sessions/${institutionId}`, { method: 'DELETE' });
    if (res.ok) {
      console.log(`✅ Session cleared for ${institutionId}`);
    } else {
      console.error(`❌ Failed to clear session for ${institutionId}`);
    }
  });

// ─── Dev Commands ───

program
  .command('dev <institutionId>')
  .description('Run AI ingestion in interactive mode (shows each step)')
  .option('--from <date>', 'Start date (YYYY-MM-DD)')
  .option('--to <date>', 'End date (YYYY-MM-DD)')
  .action(async (institutionId: string, opts) => {
    const query = new URLSearchParams();
    if (opts.from) query.set('from', opts.from);
    if (opts.to) query.set('to', opts.to);
    
    console.log(`\n🔍 Running AI agent for ${institutionId} in interactive mode...`);
    console.log('  Watch each step as the AI navigates and extracts data.\n');
    
    const res = await fetch(`${API_URL}/api/ingest/${institutionId}?${query}`, { method: 'POST' });
    const run = await res.json();
    
    if (run.error) {
      console.error(`❌ ${run.error}`);
      return;
    }
    
    for (const step of run.steps) {
      const icon = step.result === 'success' ? '🟢' : step.result === 'failed' ? '🔴' : '🟡';
      console.log(`  [${step.order}] ${icon} ${step.action}`);
      if (step.message) console.log(`       ${step.message}`);
      if (step.llmDecision) {
        try {
          const decision = JSON.parse(step.llmDecision);
          console.log(`       → LLM chose: ${decision.action} — "${decision.targetText}"`);
        } catch {}
      }
    }
    
    console.log(`\n  ✅ Complete: ${run.transactionsIngested} transactions ingested`);
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

    const dbPath = opts.db || path.join(os.tmpdir(), 'seville', `consolidate-${Date.now()}.db`);
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
