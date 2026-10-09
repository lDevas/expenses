import type { Transaction } from '../types/models.ts';
import type { CategoryDirection } from '../types/categories.ts';

export type DirectionFilter = '' | CategoryDirection;
export const UNCATEGORIZED_FILTER = 'uncategorized';

export function transactionDirection(transaction: Pick<Transaction, 'category' | 'amount'>): CategoryDirection | null {
  if (['internal-transfer', 'card-payment', 'fx-exchange'].includes(transaction.category ?? '')) return null;
  return transaction.amount < 0 ? 'expense' : transaction.amount > 0 ? 'income' : null;
}

export function matchesCategoryFilters(transaction: Transaction, direction: DirectionFilter, categoryId: string): boolean {
  const actualDirection = transactionDirection(transaction);
  if (direction && actualDirection !== direction) return false;
  if (!categoryId) return true;
  if (!actualDirection) return false;
  return categoryId === UNCATEGORIZED_FILTER ? !transaction.categoryId : transaction.categoryId === categoryId;
}

export function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
