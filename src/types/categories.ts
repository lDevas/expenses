export type CategoryDirection = 'expense' | 'income';
export type CategorySource = 'rule' | 'manual' | 'uncategorized' | 'excluded';

export interface UserCategory {
  id: string;
  name: string;
  direction: CategoryDirection;
}

export interface CategorySummary extends UserCategory {
  transactionCount: number;
  ruleCount: number;
  overrideCount: number;
  canDelete: boolean;
}

export interface CategoryRuleInput {
  name: string;
  categoryId: string;
  pattern: string;
  accountingType: string | null;
  enabled: boolean;
}

export interface CategoryRule extends CategoryRuleInput {
  id: string;
  position: number;
}

export interface CategoryAssignment {
  categoryId: string | null;
  categoryName: string | null;
  categorySource: CategorySource;
  matchedRuleId: string | null;
}

export interface RulePreview {
  matchCount: number;
  changedCount: number;
  examples: {
    id: string;
    description: string;
    amount: number;
    currency: string;
    before: string | null;
    after: string | null;
    changed: boolean;
    manual: boolean;
  }[];
}
