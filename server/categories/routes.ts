import { Hono, type Context } from 'hono';
import type { DatabaseQueries } from '../db/queries.ts';
import { CategoryError } from './store.ts';

async function body(c: Context): Promise<Record<string, unknown>> {
  let data: unknown;
  try { data = await c.req.json(); } catch { throw new CategoryError('Invalid JSON request'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new CategoryError('Expected an object');
  return data as Record<string, unknown>;
}

export function categoryRoutes(db: DatabaseQueries): Hono {
  const app = new Hono();
  const store = db.categories;
  app.get('/categories', c => c.json(store.summary(db.getTransactions())));
  app.post('/categories', async c => c.json(store.saveCategory(await body(c)), 201));
  app.put('/categories/:id', async c => c.json(store.saveCategory(await body(c), c.req.param('id'))));
  app.delete('/categories/:id', c => {
    store.deleteCategory(c.req.param('id'));
    return c.json({ ok: true });
  });
  app.post('/categories/:id/merge', async c => {
    store.merge(c.req.param('id'), (await body(c)).targetId);
    return c.json({ ok: true });
  });

  app.get('/category-rules', c => c.json(store.rules()));
  app.post('/category-rules', async c => c.json(store.saveRule(await body(c)), 201));
  app.post('/category-rules/preview', async c => {
    const data = await body(c);
    if (data.id !== undefined && typeof data.id !== 'string') throw new CategoryError('Invalid rule ID');
    return c.json(store.preview(data, db.getTransactions(), data.id as string | undefined));
  });
  app.put('/category-rules/order', async c => {
    store.reorder((await body(c)).ids);
    return c.json(store.rules());
  });
  app.put('/category-rules/:id', async c => c.json(store.saveRule(await body(c), c.req.param('id'))));
  app.delete('/category-rules/:id', c => {
    store.deleteRule(c.req.param('id'));
    return c.json({ ok: true });
  });

  app.put('/transactions/:id/category', async c => {
    const transaction = db.getTransaction(c.req.param('id'));
    if (!transaction) throw new CategoryError('Transaction not found', 404);
    store.setOverride(transaction, (await body(c)).categoryId);
    return c.json(db.getTransaction(transaction.id));
  });
  app.delete('/transactions/:id/category', c => {
    const transaction = db.getTransaction(c.req.param('id'));
    if (!transaction) throw new CategoryError('Transaction not found', 404);
    store.resetOverride(transaction.id);
    return c.json(db.getTransaction(transaction.id));
  });
  return app;
}
