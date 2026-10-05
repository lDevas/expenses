import type { AgentConfig } from '../../src/types/models.ts';

export const etoroConfig: AgentConfig = {
  id: 'etoro',
  name: 'eToro',
  type: 'brokerage',
  country: 'IL',
  currency: 'USD',
  initialUrl: 'https://www.etoro.com/dashboard',
  parser: 'csv',
  steps: [
    {
      id: 'navigate-to-portfolio',
      instruction: 'Navigate to https://www.etoro.com/dashboard. If not already logged in via cookies, look for "Log In" at the top right. Once logged in, you should see your portfolio dashboard with investments, cash balance, and performance.',
    },
    {
      id: 'navigate-to-transaction-history',
      instruction: 'Look for "Trade History", "Activity", "Transactions", or "Reports" in the sidebar or top navigation. Click on "Trade History" or "Activity" to see your trading history.',
    },
    {
      id: 'select-date-range',
      instruction: 'Look for a date range filter (usually "Date" dropdown). Select "Custom" or "All" and set the range to the past 90 days. Look for "From" and "To" date pickers. Set dates in MM/DD/YYYY format.',
    },
    {
      id: 'export-transactions-csv',
      instruction: 'Look for an "Export" or "Download" button, usually near the top of the transaction table. Select "Export as CSV" or "Download CSV". The file should download automatically.',
    },
    {
      id: 'navigate-to-portfolio-export',
      instruction: 'Navigate back to your Portfolio view. Look for "Portfolio", "Investments", or "Positions" in the sidebar. If you see a "Reports" or "Documents" section, look for "Portfolio Statement" or "Position Report".',
    },
    {
      id: 'export-positions',
      instruction: 'Look for "Export", "Download", "Statements", or "Reports". Look for options like "Portfolio Summary", "Current Positions", or "Holdings Report". Export as CSV or PDF.',
    },
  ],
  completionCriteria: [
    'Export complete',
    'Download started',
    'CSV downloaded',
    'File exported',
  ],
};
