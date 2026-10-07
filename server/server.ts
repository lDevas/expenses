import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { DatabaseQueries } from './db/queries.ts';
import { applySchema } from './db/schemaSql.ts';
import { runConsolidation } from './pipeline.ts';
import { parseDateBound } from '../src/lib/dates.ts';

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

// ─── Hono app ───

const PORT = parseInt(process.env.SERVER_PORT || '3456');

// Dependency injection keeps API tests and CLI imports away from the saved database.
export function createApp(db: DatabaseQueries): Hono {
  const app = new Hono();

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

  // ─── Data Endpoints ───

  // GET /api/accounts
  app.get('/api/accounts', (c) => {
    const accounts = db.getInstitutions().flatMap((inst) =>
      db.getAccountsByInstitution(inst.id)
    );
    return c.json(accounts);
  });

  app.get('/api/accounts/upload-ranges', (c) => c.json(db.getAccountUploadRanges()));

  app.get('/api/accounts/:id/upload-range', (c) => {
    const range = db.getAccountUploadRanges().find(a => a.accountId === c.req.param('id'));
    return range ? c.json(range) : c.json({ error: 'Account not found' }, 404);
  });

  app.get('/api/consolidation/runs', (c) => c.json(db.getConsolidationRuns()));

  app.get('/api/consolidation/runs/:id', (c) => {
    const result = db.getConsolidated(c.req.param('id'));
    return result ? c.json(result) : c.json({ error: 'Consolidation run not found' }, 404);
  });

  // GET /api/accounts/:id/transactions
  app.get('/api/accounts/:id/transactions', (c) => {
    const accountId = c.req.param('id');
    const query = c.req.query();
    if ((query.from && !parseDateBound(query.from)) || (query.to && !parseDateBound(query.to, true))) return c.json({ error: 'Invalid date range' }, 400);
    if (query.from && query.to && parseDateBound(query.from)! > parseDateBound(query.to, true)!) return c.json({ error: 'Invalid date range' }, 400);
    const transactions = db.getTransactions(
      accountId,
      query.from ? parseDateBound(query.from) : undefined,
      query.to ? parseDateBound(query.to, true) : undefined,
    );
    return c.json(transactions);
  });

  // GET /api/transactions
  app.get('/api/transactions', (c) => {
    const query = c.req.query();
    if ((query.from && !parseDateBound(query.from)) || (query.to && !parseDateBound(query.to, true))) return c.json({ error: 'Invalid date range' }, 400);
    if (query.from && query.to && parseDateBound(query.from)! > parseDateBound(query.to, true)!) return c.json({ error: 'Invalid date range' }, 400);
    const transactions = db.getTransactions(
      query.account || undefined,
      query.from ? parseDateBound(query.from) : undefined,
      query.to ? parseDateBound(query.to, true) : undefined,
    );
    return c.json(transactions);
  });

  // GET /api/fx/latest — latest FX exchange done on any account (null if none).
  // The Dashboard uses its implied rate to normalize UYU/USD.
  app.get('/api/fx/latest', (c) => {
    return c.json(db.getLatestExchange());
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
  // (all saved sources by default; pass ?run= for an immutable upload snapshot).
  app.get('/api/statements/consolidated', (c) => {
    const runId = c.req.query('run') || undefined;
    const result = db.getConsolidated(runId);
    if (!result) {
      return c.json({ error: 'No consolidation run found — upload statement files first' }, 404);
    }
    return c.json(result);
  });

  // ─── Health Check ───

  app.get('/api/health', (c) =>
    c.json({ status: 'ok', timestamp: new Date().toISOString() })
  );

  return app;
}

// ─── Server start ───

export function startServer(): void {
  const db = initializeDatabase();
  const app = createApp(db);
  serve({ fetch: app.fetch, port: PORT }, () => {
    console.log(`🏦 Seville API running at http://localhost:${PORT}`);
    console.log(`📊 Database: ${db.getDatabasePath()}`);
  });
}
