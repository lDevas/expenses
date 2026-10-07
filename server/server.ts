import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { DatabaseQueries } from './db/queries.ts';
import { applySchema } from './db/schemaSql.ts';
import { AgentOrchestrator } from './ingestion/agent.ts';
import { PdfStatementParser } from './ingestion/parsers/pdfParser.ts';
import { runConsolidation } from './pipeline.ts';
import { santanderConfig } from './agents/santander.ts';
import { itauConfig } from './agents/itau.ts';
import { prexConfig } from './agents/prex.ts';
import { etoroConfig } from './agents/etoro.ts';
import { interactiveBrokersConfig } from './agents/interactiveBrokers.ts';
import type { Institution, Account, Transaction, IngestionRun } from '../src/types/models.ts';

const DATA_DIR = path.join(path.resolve('.'), 'data');
const DB_PATH = path.join(DATA_DIR, 'expenses.db');

// ─── Database initialization ───

function initializeDatabase(): DatabaseQueries {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  db.pragma('foreign_keys = ON');

  applySchema(db);

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
  c.header('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
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

// GET /api/fx/latest — latest FX exchange done on any account (null if none).
// The Dashboard uses its implied rate to normalize UYU/USD.
app.get('/api/fx/latest', (c) => {
  return c.json(db.getLatestExchange());
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

// ─── Statement Consolidation Endpoints ───

// POST /api/statements/upload — batch upload (one or more statement files).
// Runs the full pipeline: parse each file → consolidate → persist one run.
app.post('/api/statements/upload', async (c) => {
  const formData = await c.req.formData();
  const entries = formData.getAll('file');
  const files = entries.filter((e): e is File => e instanceof File);

  if (files.length === 0) {
    return c.json({ error: 'No files provided (append one or more "file" fields)' }, 400);
  }

  const buffers = await Promise.all(
    files.map(async (f) => ({ name: f.name, buffer: Buffer.from(await f.arrayBuffer()) })),
  );

  const { result } = await runConsolidation(buffers, db);
  return c.json({
    runId: result.runId,
    itemCount: result.items.length,
    transferCount: result.transfers.length,
    exchangeCount: result.exchanges.length,
    positionCount: result.positions.length,
    realizedCount: result.realized.length,
    issueCount: result.issues.length,
    files: result.files,
  }, 201);
});

// GET /api/statements/consolidated — the stored result of a consolidation run
// (latest by default; pass ?run= to select one).
app.get('/api/statements/consolidated', (c) => {
  const runId = c.req.query('run') || undefined;
  const result = db.getConsolidated(runId);
  if (!result) {
    return c.json({ error: 'No consolidation run found — upload statement files first' }, 404);
  }
  return c.json(result);
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
