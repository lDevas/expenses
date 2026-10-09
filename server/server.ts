import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { DatabaseQueries } from './db/queries.ts';
import { applySchema } from './db/schemaSql.ts';
import { runConsolidation } from './pipeline.ts';
import { parseDateBound } from '../src/lib/dates.ts';
import { categoryRoutes } from './categories/routes.ts';
import { CategoryError } from './categories/store.ts';

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
    if (err instanceof CategoryError) return c.json({ error: err.message }, err.status);
    console.error(`[API Error] ${c.req.path} — ${err.message}`);
    return c.json({ error: err.message || 'Internal server error' }, 500);
  });

  // ─── Data Endpoints ───
  app.route('/api', categoryRoutes(db));

  // GET /api/accounts
  app.get('/api/accounts', (c) => {
    const accounts = db.getInstitutions().flatMap((inst) =>
      db.getAccountsByInstitution(inst.id)
    );
    return c.json(accounts);
  });

  // Investment reports are scoped by account type, never by transaction category.
  app.get('/api/investments', (c) => {
    const accounts = db.getInstitutions().flatMap(inst =>
      db.getAccountsByInstitution(inst.id).filter(a => a.type === 'investment')
        .map(a => ({ ...a, name: inst.name })));
    const cash = db.getInvestmentCash();
    const labels = new Map(accounts.map(a => [a.id, `${a.name}${a.accountNumber ? ` · ${a.accountNumber}` : ''}`]));
    const runId = c.req.query('run');
    const result = runId ? db.getConsolidatedReport(runId) : db.getConsolidated();
    if (runId && !result) return c.json({ error: 'Consolidation run not found' }, 404);
    if (!result) return c.json({ accounts, cash, result: null });
    const items = result.items.filter(i => labels.has(i.accountId))
      .map(i => ({ ...i, accountLabel: labels.get(i.accountId)! }));
    const positions = result.positions.filter(p => labels.has(p.accountId))
      .map(p => ({ ...p, accountLabel: labels.get(p.accountId)! }));
    const realized = result.realized.filter(r => labels.has(r.accountId))
      .map(r => ({ ...r, accountLabel: labels.get(r.accountId)! }));
    // A matched bank leg is context for a broker wire, not bank investment activity.
    const transfers = result.transfers.filter(t => t.kind === 'wire' &&
      (labels.has(t.fromAccountId ?? '') || labels.has(t.toAccountId ?? '')))
      .map(t => ({ ...t,
        fromAccountLabel: t.fromAccountId ? labels.get(t.fromAccountId) ?? t.fromAccountLabel : 'External account',
        toAccountLabel: t.toAccountId ? labels.get(t.toAccountId) ?? t.toAccountLabel : 'External account',
      }));
    const investmentFiles = new Set(db.getAccountUploadRanges().filter(a => labels.has(a.accountId))
      .flatMap(a => a.uploads.flatMap(u => u.file ? [u.file] : [])));
    const exchanges = result.exchanges.filter(e => labels.has(e.accountId ?? ''));
    return c.json({ accounts, cash, result: { ...result, items, positions, realized, transfers, exchanges,
      issues: result.issues.filter(issue => investmentFiles.has(issue.file)),
      files: result.files.filter(file => investmentFiles.has(file)),
    } });
  });

  app.get('/api/accounts/upload-ranges', (c) => c.json(db.getAccountUploadRanges()));

  app.get('/api/accounts/:id/upload-range', (c) => {
    const range = db.getAccountUploadRanges().find(a => a.accountId === c.req.param('id'));
    return range ? c.json(range) : c.json({ error: 'Account not found' }, 404);
  });

  app.get('/api/consolidation/runs', (c) => c.json(db.getConsolidationRuns()));

  app.get('/api/consolidation/runs/:id/report', (c) => {
    const result = db.getConsolidatedReport(c.req.param('id'));
    return result ? c.json(result) : c.json({ error: 'Consolidation run not found' }, 404);
  });

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

  app.delete('/api/transactions/:id', (c) => {
    return db.deleteTransaction(c.req.param('id'))
      ? c.json({ deleted: true })
      : c.json({ error: 'Transaction not found' }, 404);
  });

  // GET /api/fx/latest — latest FX exchange done on any account (null if none).
  // The Dashboard uses its implied rate to normalize UYU/USD.
  app.get('/api/fx/latest', (c) => {
    return c.json(db.getLatestExchange());
  });

  // GET /api/net-worth?from&to&account — bank + investment net worth series
  // for the dashboard and details page. The client normalizes currencies.
  app.get('/api/net-worth', (c) => {
    const query = c.req.query();
    if ((query.from && !parseDateBound(query.from)) || (query.to && !parseDateBound(query.to, true))) return c.json({ error: 'Invalid date range' }, 400);
    if (query.from && query.to && parseDateBound(query.from)! > parseDateBound(query.to, true)!) return c.json({ error: 'Invalid date range' }, 400);
    return c.json(db.getNetWorth(
      query.from ? parseDateBound(query.from) : undefined,
      query.to ? parseDateBound(query.to, true) : undefined,
      query.account || undefined,
    ));
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
