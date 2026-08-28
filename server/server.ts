import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { DatabaseQueries } from './db/queries';
import { AgentOrchestrator } from './ingestion/agent';
import { PdfStatementParser } from './ingestion/parsers/pdfParser';
import { santanderConfig } from './agents/santander';
import { itauConfig } from './agents/itau';
import { prexConfig } from './agents/prex';
import { etoroConfig } from './agents/etoro';
import { interactiveBrokersConfig } from './agents/interactiveBrokers';
import type { Institution, Account, Transaction, IngestionRun } from '../src/types/models';

const SEILLE_DIR = path.join(process.env.HOME || '', '.seville');
const DB_PATH = path.join(SEILLE_DIR, 'seville.db');

// ─── Database initialization ───

function initializeDatabase(): DatabaseQueries {
  fs.mkdirSync(SEILLE_DIR, { recursive: true });

  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS institutions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      country TEXT NOT NULL,
      currency TEXT NOT NULL,
      last_sync TEXT,
      status TEXT NOT NULL DEFAULT 'needs-setup'
    );

    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      institution_id TEXT NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      currency TEXT NOT NULL,
      balance REAL NOT NULL DEFAULT 0,
      balance_date TEXT NOT NULL,
      account_number TEXT,
      FOREIGN KEY (institution_id) REFERENCES institutions(id)
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      date TEXT NOT NULL,
      post_date TEXT,
      description TEXT NOT NULL,
      amount REAL NOT NULL,
      currency TEXT NOT NULL,
      category TEXT,
      subcategory TEXT,
      reference TEXT,
      metadata TEXT,
      source TEXT NOT NULL,
      imported_at TEXT NOT NULL,
      FOREIGN KEY (account_id) REFERENCES accounts(id)
    );

    CREATE INDEX IF NOT EXISTS idx_transactions_account_id ON transactions(account_id);
    CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(date);
    CREATE INDEX IF NOT EXISTS idx_transactions_account_date ON transactions(account_id, date);

    CREATE TABLE IF NOT EXISTS ingestion_runs (
      id TEXT PRIMARY KEY,
      institution_id TEXT NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      status TEXT NOT NULL,
      transactions_ingested INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      FOREIGN KEY (institution_id) REFERENCES institutions(id)
    );

    CREATE TABLE IF NOT EXISTS ingestion_steps (
      id TEXT PRIMARY KEY,
      ingestion_run_id TEXT NOT NULL,
      "order" INTEGER NOT NULL,
      action TEXT NOT NULL,
      result TEXT NOT NULL,
      message TEXT,
      screenshot_path TEXT,
      llm_decision TEXT,
      FOREIGN KEY (ingestion_run_id) REFERENCES ingestion_runs(id)
    );

    CREATE TABLE IF NOT EXISTS browser_sessions (
      institution_id TEXT PRIMARY KEY,
      cookies TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT
    );
  `);

  const queries = new DatabaseQueries(db);
  queries.seedDefaultInstitutions();
  return queries;
}

// ─── Parser helpers ───

function detectParserType(filename: string): 'pdf' | 'csv' | 'excel' {
  const ext = path.extname(filename).toLowerCase();
  switch (ext) {
    case '.pdf':
      return 'pdf';
    case '.csv':
      return 'csv';
    case '.xlsx':
    case '.xls':
      return 'excel';
    default:
      return 'pdf';
  }
}

// ─── CSV / Excel stubs (parsers not yet implemented) ───

async function parseCsv(_buffer: Buffer, _institutionId: string): Promise<Transaction[]> {
  return [];
}

async function parseExcel(_buffer: Buffer, _institutionId: string): Promise<Transaction[]> {
  return [];
}

// ─── Agent config lookup ───

const agentConfigs: Record<string, any> = {
  'santander-uy': santanderConfig,
  'itau-uy': itauConfig,
  'prex-uy': prexConfig,
  'etoro': etoroConfig,
  'interactive-brokers': interactiveBrokersConfig,
};

// ─── Hono app ───

const app = new Hono();
const PORT = parseInt(process.env.SERVER_PORT || '3456');
const db = initializeDatabase();
const agent = new AgentOrchestrator(db);

// ─── CORS middleware ───

app.use('*', async (c, next) => {
  c.header('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || 'http://localhost:5173');
  c.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  c.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (c.req.method === 'OPTIONS') {
    return c.body(null, 204);
  }
  await next();
});

// ─── Error-handling middleware ───

app.onError((err, c) => {
  console.error(`[API Error] ${c.req.path} — ${err.message}`);
  return c.json({ error: err.message || 'Internal server error' }, 500);
});

// ─── Ingestion Endpoints ───

// POST /api/ingest/:institutionId
app.post('/api/ingest/:institutionId', async (c) => {
  const institutionId = c.req.param('institutionId');
  const config = agentConfigs[institutionId];

  if (!config) {
    return c.json({ error: `Unknown institution: ${institutionId}` }, 404);
  }

  const query = c.req.query();
  const dateRange = {
    from: query.from ? new Date(query.from) : new Date(Date.now() - 90 * 24 * 60 * 60 * 1000),
    to: query.to ? new Date(query.to) : new Date(),
  };

  const run = await agent.run(config, dateRange);
  return c.json(run);
});

// GET /api/ingest/:institutionId/latest
app.get('/api/ingest/:institutionId/latest', (c) => {
  const run = db.getLatestIngestionRun(c.req.param('institutionId'));
  return c.json(run || null);
});

// GET /api/ingest/status
app.get('/api/ingest/status', (c) => {
  const institutions = db.getInstitutions();
  const statuses = institutions.map((inst) => ({
    ...inst,
    lastRun: db.getLatestIngestionRun(inst.id),
  }));
  return c.json(statuses);
});

// ─── Data Endpoints ───

// GET /api/accounts
app.get('/api/accounts', (c) => {
  const accounts = db.getInstitutions().flatMap((inst) =>
    db.getAccountsByInstitution(inst.id)
  );
  return c.json(accounts);
});

// GET /api/accounts/:id/transactions
app.get('/api/accounts/:id/transactions', (c) => {
  const accountId = c.req.param('id');
  const query = c.req.query();
  const transactions = db.getTransactions(
    accountId,
    query.from ? new Date(query.from) : undefined,
    query.to ? new Date(query.to) : undefined,
  );
  return c.json(transactions);
});

// GET /api/transactions
app.get('/api/transactions', (c) => {
  const query = c.req.query();
  const transactions = db.getTransactions(
    query.account || undefined,
    query.from ? new Date(query.from) : undefined,
    query.to ? new Date(query.to) : undefined,
  );
  return c.json(transactions);
});

// ─── File Upload Endpoints ───

// POST /api/transactions/upload
app.post('/api/transactions/upload', async (c) => {
  const formData = await c.req.formData();
  const file = formData.get('file') as File | null;
  const institutionId = (formData.get('institutionId') as string) || '';
  const parserType = ((formData.get('parserType') as string) || detectParserType(file?.name || '')) as 'pdf' | 'csv' | 'excel';

  if (!file) {
    return c.json({ error: 'No file provided' }, 400);
  }

  const buffer = Buffer.from(await file.arrayBuffer());

  let transactions: Transaction[];
  switch (parserType) {
    case 'pdf':
      transactions = await new PdfStatementParser().parse(buffer, institutionId);
      break;
    case 'csv':
      transactions = await parseCsv(buffer, institutionId);
      break;
    case 'excel':
      transactions = await parseExcel(buffer, institutionId);
      break;
    default:
      return c.json({ error: `Unsupported file type: ${parserType}` }, 400);
  }

  for (const txn of transactions) {
    txn.source = 'file-upload';
    db.saveTransaction(txn);
  }

  return c.json({
    transactionsIngested: transactions.length,
    transactions,
  }, 201);
});

// ─── Session Management Endpoints ───

// POST /api/sessions/:institutionId/export
app.post('/api/sessions/:institutionId/export', async (c) => {
  const institutionId = c.req.param('institutionId');
  const config = agentConfigs[institutionId];
  if (!config) {
    return c.json({ error: `Unknown institution: ${institutionId}` }, 404);
  }

  await agent.exportSession(config);
  return c.json({ success: true, message: 'Session exported. Cookies saved.' });
});

// GET /api/sessions
app.get('/api/sessions', (c) => {
  const sessions = db.listBrowserSessions();
  return c.json(sessions);
});

// DELETE /api/sessions/:institutionId
app.delete('/api/sessions/:institutionId', (c) => {
  db.deleteBrowserSession(c.req.param('institutionId'));
  return c.json({ success: true });
});

// ─── Health Check ───

app.get('/api/health', (c) =>
  c.json({ status: 'ok', timestamp: new Date().toISOString() })
);

// ─── Server start ───

export function startServer(): void {
  serve({ fetch: app.fetch, port: PORT }, (info) => {
    console.log(`🏦 Seville API running at http://localhost:${PORT}`);
    console.log(`📊 Database: ${db.getDatabasePath()}`);
  });
}

export { app };
