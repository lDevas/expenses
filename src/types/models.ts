// ─── Core Financial Entities ───

export interface Institution {
  id: string;                    // e.g., "santander-uy"
  name: string;
  type: InstitutionType;
  country: string;               // "UY" or "US"
  currency: string;              // "UYU", "USD"
  lastSync: Date | null;
  status: InstitutionStatus;
}

export type InstitutionType = 'bank' | 'brokerage' | 'credit';
export type InstitutionStatus = 'active' | 'error' | 'needs-setup';

export interface Account {
  id: string;
  institutionId: string;
  name: string;                  // "Cuenta Corriente", "Cuenta Inversión"
  type: AccountType;
  currency: string;
  balance: number;
  balanceDate: Date;
  accountNumber?: string;        // Masked for display
}

export type AccountType = 'checking' | 'savings' | 'investment' | 'credit' | 'loan';

export interface Transaction {
  id: string;
  accountId: string;
  date: Date;                    // Transaction date
  postDate?: Date;               // Settlement/posting date
  description: string;
  amount: number;                // Positive = credit/income, negative = debit/expense
  currency: string;
  category?: string;             // AI-assigned or manual
  subcategory?: string;
  reference?: string;            // Reference number from bank
  metadata?: Record<string, any>; // Raw data from bank for audit trail
  source: TransactionSource;
  importedAt: Date;
}

export type TransactionSource = 'ai-ingestion' | 'file-upload' | 'manual-entry';

// ─── Ingestion-Specific ───

export interface IngestionRun {
  id: string;
  institutionId: string;
  startedAt: Date;
  completedAt?: Date;
  status: IngestionStatus;
  transactionsIngested: number;
  error?: string;
  steps: IngestionStep[];
}

export type IngestionStatus = 'running' | 'success' | 'error' | 'partial';

export interface IngestionStep {
  order: number;
  action: string;                // "Navigate to downloads page"
  result: StepResult;
  message?: string;
  screenshotPath?: string;       // For debugging
  llmDecision?: string;          // What the LLM decided
}

export type StepResult = 'success' | 'skipped' | 'failed';

// ─── AI Agent Types ───

export interface AgentConfig {
  id: string;
  name: string;
  type: InstitutionType;
  country: string;
  currency: string;
  initialUrl: string;
  steps: AgentStep[];
  fallbacks?: Fallback[];
  completionCriteria: string[];
  parser?: 'pdf' | 'csv' | 'excel' | 'html';
  parserOptions?: Record<string, any>;
}

export interface AgentStep {
  id: string;
  instruction: string;           // Plain English instructions for the LLM
  expectedOutcome?: string;
  maxRetries?: number;
  timeoutSeconds?: number;
}

export interface Fallback {
  trigger: string;               // What triggers this fallback (LLM-detected)
  instruction: string;           // Alternative instructions
}

// ─── AI Decision Types ───

export interface LlmDecision {
  action: 'navigate' | 'click' | 'extract' | 'done' | 'wait';
  target: string;                // Description of what to interact with
  targetText: string;            // What is visible on screen
  data?: Record<string, any>;    // Extracted data (transactions, positions, etc.)
}

export interface BrowserSession {
  institutionId: string;
  cookies: Record<string, any>;  // Cookie data
  createdAt: string;             // ISO timestamp
  expiresAt?: string;            // ISO timestamp
}

// ─── Consolidation (statement pipeline) ───

export type ConsolidatedCategory =
  | 'expense'
  | 'income'
  | 'transfer-in'
  | 'transfer-out'
  | 'internal-transfer'
  | 'fx-exchange'
  | 'investment-income'
  | 'tax'
  | 'fee'
  | 'card-payment'
  | 'other';

export type MatchStatus = 'matched' | 'unmatched';

export interface ConsolidatedItem {
  id: string;
  accountId: string;
  accountLabel: string;
  date: string;
  description: string;
  amount: number;
  currency: string;
  category: ConsolidatedCategory;
  reference?: string;
  metadata?: Record<string, any>;
  sourceFiles: string[];
}

export interface ConsolidatedTransfer {
  id: string;
  kind: 'wire' | 'card' | 'internal';
  matchStatus: MatchStatus;
  fromAccountId?: string;
  fromAccountLabel: string;
  fromCurrency?: string;
  fromAmount?: number;
  fromDate?: string;
  fromDescription?: string;
  toAccountId?: string;
  toAccountLabel: string;
  toCurrency?: string;
  toAmount?: number;
  toDate?: string;
  toDescription?: string;
  impliedRate?: number;
  sourceFiles: string[];
}

export interface ConsolidatedExchange {
  id: string;
  matchStatus: MatchStatus;
  accountId?: string;
  accountLabel: string;
  date?: string;
  description?: string;
  fromCurrency?: string;
  fromAmount?: number;
  toCurrency?: string;
  toAmount?: number;
  impliedRate?: number;
  sourceFiles: string[];
}

export interface ConsolidatedPosition {
  id: string;
  accountId: string;
  accountLabel: string;
  symbol: string;
  name?: string;
  qty: number;
  costBasis?: number;
  value?: number;
  unrealizedPl?: number;
  snapshotDate: string;
  currency: string;
  metadata?: Record<string, any>;
  sourceFiles: string[];
}

export interface ConsolidatedRealized {
  id: string;
  accountId: string;
  accountLabel: string;
  symbol: string;
  name?: string;
  date: string;
  qty?: number;
  proceeds?: number;
  costBasis?: number;
  realizedPl: number;
  currency: string;
  metadata?: Record<string, any>;
  sourceFiles: string[];
}

export interface ConsolidatedIssue {
  file: string;
  sheet?: string;
  row?: number;
  field?: string;
  raw?: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
}

export interface ConsolidatedResult {
  runId: string;
  generatedAt: string;
  files: string[];
  items: ConsolidatedItem[];
  transfers: ConsolidatedTransfer[];
  exchanges: ConsolidatedExchange[];
  positions: ConsolidatedPosition[];
  realized: ConsolidatedRealized[];
  issues: ConsolidatedIssue[];
}

// ─── Utility / ID Generation ───

export function generateId(): string {
  return crypto.randomUUID();
}

export function now(): Date {
  return new Date();
}
