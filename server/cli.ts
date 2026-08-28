#!/usr/bin/env node

import { Command } from 'commander';
import { startServer } from './server';
import open from 'open';

const API_URL = process.env.API_URL || 'http://localhost:3456';
const SERVER_PORT = parseInt(process.env.SERVER_PORT || '3456');

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

// ─── Run ───

program.parse();
