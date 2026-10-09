import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Database } from 'better-sqlite3';
import type { Transaction } from '../../src/types/models.ts';
import type { CategoryRule, CategoryRuleInput, CategorySummary, RulePreview, UserCategory } from '../../src/types/categories.ts';
import { transactionDirection } from '../../src/lib/categories.ts';
import { compilePattern, createClassifier, normalizeDescription } from './engine.ts';

export class CategoryError extends Error {
  status: 400 | 404 | 409;
  constructor(message: string, status: 400 | 404 | 409 = 400) {
    super(message);
    this.status = status;
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CategoryError('Expected an object');
  return value as Record<string, unknown>;
}

function name(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 100) throw new CategoryError('Name must be between 1 and 100 characters');
  return value.trim();
}

export class CategoryStore {
  private db: Database;
  constructor(db: Database) {
    this.db = db;
    this.seed();
  }

  private seed(): void {
    if (this.db.prepare("SELECT 1 FROM category_settings WHERE key = 'seed-v1'").get()) return;
    const seed = JSON.parse(readFileSync(new URL('./seed.json', import.meta.url), 'utf8')) as {
      categories: UserCategory[]; rules: Omit<CategoryRule, 'position'>[];
    };
    this.db.transaction(() => {
      const category = this.db.prepare('INSERT INTO user_categories (id, name, direction) VALUES (?, ?, ?)');
      for (const c of seed.categories) category.run(c.id, c.name, c.direction);
      for (const [position, rule] of seed.rules.entries()) this.writeRule({ ...rule, position });
      this.db.prepare("INSERT INTO category_settings (key, value) VALUES ('seed-v1', '1')").run();
    })();
  }

  list(): UserCategory[] {
    return this.db.prepare('SELECT * FROM user_categories ORDER BY direction, name COLLATE NOCASE').all() as UserCategory[];
  }

  get(id: string): UserCategory {
    const category = this.db.prepare('SELECT * FROM user_categories WHERE id = ?').get(id) as UserCategory | undefined;
    if (!category) throw new CategoryError('Category not found', 404);
    return category;
  }

  summary(transactions: Transaction[]): CategorySummary[] {
    const rules = this.rules();
    const overrides = [...this.overrides().values()];
    return this.list().map(category => {
      const transactionCount = transactions.filter(t => t.categoryId === category.id).length;
      const ruleCount = rules.filter(rule => rule.categoryId === category.id).length;
      const overrideCount = overrides.filter(id => id === category.id).length;
      return { ...category, transactionCount, ruleCount, overrideCount, canDelete: !transactionCount && !ruleCount && !overrideCount };
    });
  }

  saveCategory(input: unknown, id?: string): UserCategory {
    const data = object(input);
    const previous = id ? this.get(id) : undefined;
    const direction = data.direction ?? previous?.direction;
    if (direction !== 'expense' && direction !== 'income') throw new CategoryError('Choose Expenses or Income');
    if (previous && previous.direction !== direction) throw new CategoryError('A category’s type cannot be changed; create a new category instead');
    const category: UserCategory = { id: id ?? randomUUID(), name: name(data.name), direction };
    const duplicate = this.db.prepare('SELECT id FROM user_categories WHERE name = ? COLLATE NOCASE AND direction = ? AND id != ?')
      .get(category.name, direction, category.id);
    if (duplicate) throw new CategoryError('A category with this name already exists for this type', 409);
    this.db.prepare(`INSERT INTO user_categories (id, name, direction) VALUES (@id, @name, @direction)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name`).run(category);
    return category;
  }

  deleteCategory(id: string): void {
    this.get(id);
    if (this.rules().some(rule => rule.categoryId === id) || [...this.overrides().values()].includes(id)) {
      throw new CategoryError('This category is in use. Merge it into another category instead.', 409);
    }
    this.db.prepare('DELETE FROM user_categories WHERE id = ?').run(id);
  }

  merge(id: string, targetId: unknown): void {
    const source = this.get(id);
    if (typeof targetId !== 'string') throw new CategoryError('Choose a destination category');
    const target = this.get(targetId);
    if (source.id === target.id || source.direction !== target.direction) throw new CategoryError('Merge into a different category of the same type');
    this.db.transaction(() => {
      this.db.prepare('UPDATE category_rules SET category_id = ? WHERE category_id = ?').run(target.id, source.id);
      this.db.prepare('UPDATE transaction_category_overrides SET category_id = ? WHERE category_id = ?').run(target.id, source.id);
      this.db.prepare('DELETE FROM user_categories WHERE id = ?').run(source.id);
    })();
  }

  rules(): CategoryRule[] {
    const rows = this.db.prepare(`SELECT id, name, category_id AS categoryId, pattern, accounting_type AS accountingType,
      enabled, position FROM category_rules ORDER BY position, id`).all() as (Omit<CategoryRule, 'enabled'> & { enabled: number })[];
    return rows.map(row => ({ ...row, enabled: !!row.enabled }));
  }

  private validateRule(input: unknown): CategoryRuleInput {
    const data = object(input);
    if (typeof data.categoryId !== 'string') throw new CategoryError('Choose a category');
    this.get(data.categoryId);
    if (typeof data.pattern !== 'string' || !data.pattern.trim() || data.pattern.length > 1000) throw new CategoryError('Pattern must be between 1 and 1,000 characters');
    try { compilePattern(data.pattern); } catch { throw new CategoryError('Invalid regular expression'); }
    if (typeof data.enabled !== 'boolean') throw new CategoryError('Enabled must be true or false');
    const accountingType = data.accountingType ?? null;
    if (accountingType !== null && !['expense', 'income', 'fee', 'tax', 'transfer-in', 'transfer-out', 'investment-income', 'other'].includes(String(accountingType))) {
      throw new CategoryError('Invalid accounting type');
    }
    return { name: name(data.name), categoryId: data.categoryId, pattern: data.pattern, enabled: data.enabled, accountingType: accountingType as string | null };
  }

  private writeRule(rule: CategoryRule): void {
    this.db.prepare(`INSERT INTO category_rules (id, name, category_id, pattern, accounting_type, enabled, position)
      VALUES (@id, @name, @categoryId, @pattern, @accountingType, @enabled, @position)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, category_id = excluded.category_id, pattern = excluded.pattern,
        accounting_type = excluded.accounting_type, enabled = excluded.enabled, position = excluded.position`)
      .run({ ...rule, enabled: Number(rule.enabled) });
  }

  private candidate(input: unknown, id?: string): CategoryRule {
    const rules = this.rules();
    const previous = id ? rules.find(rule => rule.id === id) : undefined;
    if (id && !previous) throw new CategoryError('Rule not found', 404);
    return { ...this.validateRule(input), id: id ?? randomUUID(), position: previous?.position ?? (rules[0]?.position ?? 0) - 1 };
  }

  saveRule(input: unknown, id?: string): CategoryRule {
    const rule = this.candidate(input, id);
    this.writeRule(rule);
    return rule;
  }

  deleteRule(id: string): void {
    if (!this.db.prepare('DELETE FROM category_rules WHERE id = ?').run(id).changes) throw new CategoryError('Rule not found', 404);
  }

  reorder(ids: unknown): void {
    const rules = this.rules();
    if (!Array.isArray(ids) || ids.length !== rules.length || new Set(ids).size !== rules.length ||
        ids.some(id => typeof id !== 'string' || !rules.some(rule => rule.id === id))) {
      throw new CategoryError('Order must include every rule exactly once');
    }
    this.db.transaction(() => {
      const update = this.db.prepare('UPDATE category_rules SET position = ? WHERE id = ?');
      ids.forEach((id, index) => update.run(index, id));
    })();
  }

  private overrides(): Map<string, string | null> {
    const rows = this.db.prepare('SELECT transaction_id, category_id FROM transaction_category_overrides').all() as { transaction_id: string; category_id: string | null }[];
    return new Map(rows.map(row => [row.transaction_id, row.category_id]));
  }

  assign<T extends Transaction>(transactions: T[]): T[] {
    const classify = createClassifier(this.list(), this.rules(), this.overrides());
    return transactions.map(transaction => ({ ...transaction, ...classify(transaction) }));
  }

  setOverride(transaction: Transaction, categoryId: unknown): void {
    const direction = transactionDirection(transaction);
    if (!direction) throw new CategoryError('Transfers between your accounts and zero-value rows cannot be categorized');
    if (categoryId !== null) {
      if (typeof categoryId !== 'string') throw new CategoryError('Choose a category or Uncategorized');
      if (this.get(categoryId).direction !== direction) throw new CategoryError('Category must match the transaction’s type');
    }
    this.db.prepare(`INSERT INTO transaction_category_overrides (transaction_id, category_id) VALUES (?, ?)
      ON CONFLICT(transaction_id) DO UPDATE SET category_id = excluded.category_id`).run(transaction.id, categoryId);
  }

  resetOverride(id: string): void {
    this.db.prepare('DELETE FROM transaction_category_overrides WHERE transaction_id = ?').run(id);
  }

  preview(input: unknown, transactions: Transaction[], id?: string): RulePreview {
    const candidate = this.candidate(input, id);
    const categories = this.list();
    const category = this.get(candidate.categoryId);
    const rules = this.rules();
    const overrides = this.overrides();
    const before = createClassifier(categories, rules, overrides);
    const after = createClassifier(categories, [...rules.filter(rule => rule.id !== candidate.id), candidate], overrides);
    const regex = compilePattern(candidate.pattern);
    let matchCount = 0, changedCount = 0;
    const examples: RulePreview['examples'] = [];
    for (const transaction of transactions) {
      const matches = transactionDirection(transaction) === category.direction &&
        (!candidate.accountingType || candidate.accountingType === transaction.category) && regex.test(normalizeDescription(transaction.description));
      const old = before(transaction), next = after(transaction);
      const changed = old.categoryId !== next.categoryId;
      if (matches) matchCount++;
      if (changed) changedCount++;
      if (matches || changed) examples.push({ id: transaction.id, description: transaction.description,
        amount: transaction.amount, currency: transaction.currency, before: old.categoryName, after: next.categoryName,
        changed, manual: old.categorySource === 'manual' });
    }
    examples.sort((a, b) => Number(b.changed) - Number(a.changed));
    return { matchCount, changedCount, examples: examples.slice(0, 50) };
  }
}
