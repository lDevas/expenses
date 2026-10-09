import type { Transaction } from '../../src/types/models.ts';
import type { CategoryAssignment, CategoryRule, UserCategory } from '../../src/types/categories.ts';
import { transactionDirection } from '../../src/lib/categories.ts';

export function normalizeDescription(value: string): string {
  return value.normalize('NFD').replace(/\p{M}/gu, '').replace(/\s+/g, ' ').trim();
}

export function compilePattern(pattern: string): RegExp {
  return new RegExp(pattern.normalize('NFD').replace(/\p{M}/gu, ''), 'iu');
}

export function createClassifier(categories: UserCategory[], rules: CategoryRule[], overrides: Map<string, string | null>) {
  const byId = new Map(categories.map(category => [category.id, category]));
  const compiled = [...rules].sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))
    .filter(rule => rule.enabled).map(rule => ({ rule, regex: compilePattern(rule.pattern) }));

  return (transaction: Pick<Transaction, 'id' | 'description' | 'amount' | 'category'>): CategoryAssignment => {
    const empty = { categoryId: null, categoryName: null, matchedRuleId: null };
    const direction = transactionDirection(transaction);
    if (!direction) return { ...empty, categorySource: 'excluded' };
    if (overrides.has(transaction.id)) {
      const id = overrides.get(transaction.id);
      const category = id ? byId.get(id) : undefined;
      if (!id || category?.direction === direction) {
        return { ...empty, categoryId: category?.id ?? null, categoryName: category?.name ?? null, categorySource: 'manual' };
      }
    }
    const description = normalizeDescription(transaction.description);
    for (const { rule, regex } of compiled) {
      const category = byId.get(rule.categoryId);
      if (category?.direction !== direction || (rule.accountingType && rule.accountingType !== transaction.category)) continue;
      if (regex.test(description)) return {
        categoryId: category.id, categoryName: category.name, categorySource: 'rule', matchedRuleId: rule.id,
      };
    }
    return { ...empty, categorySource: 'uncategorized' };
  };
}
