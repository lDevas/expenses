import type { AgentConfig } from '../../src/types/models';

export const interactiveBrokersConfig: AgentConfig = {
  id: 'interactive-brokers',
  name: 'Interactive Brokers',
  type: 'brokerage',
  country: 'US',
  currency: 'USD',
  initialUrl: 'https://www.interactivebrokers.com',
  parser: 'csv',
  steps: [
    {
      id: 'navigate-to-platform',
      instruction: 'Navigate to https://www.interactivebrokers.com and look for "Client Portal" or "Log In". Click "Client Portal" to reach https://portal.interactivebrokers.com. If cookies already logged you in, you should see the dashboard with account summary, P&L, and portfolio.',
    },
    {
      id: 'navigate-to-reports',
      instruction: 'Look for "Reports" in the top navigation bar. Click on "Reports". This opens the report generation page. If you don\'t see "Reports", look for "More" or the hamburger menu (three lines) in the top right.',
    },
    {
      id: 'select-trade-activity',
      instruction: 'In the Reports section, look for "Trade Activity" or "Transactions" under the "Account" or "Activity" category. Click on "Trade Activity".',
    },
    {
      id: 'select-date-range',
      instruction: 'Set the date range to the past 90 days. Look for "Date Range" dropdown — select "Custom" and set "From" and "To" dates. Use MM/DD/YYYY format. Click "Run Report".',
    },
    {
      id: 'export-trade-activity',
      instruction: 'After the report generates, look for "Export" or "Download" button (usually a download icon or "Export to CSV" / "Export to Excel"). Click it to download the trade activity as CSV.',
    },
    {
      id: 'navigate-to-portfolio-positions',
      instruction: 'Look for "Portfolio" or "Positions" in the left sidebar or top navigation. Click on "Portfolio" to see your current holdings.',
    },
    {
      id: 'export-positions',
      instruction: 'Look for "Export" or "Download" button on the Portfolio page. Select "Export to CSV" or "Export to Excel". This gives you current positions, quantities, market values, and cost basis.',
    },
    {
      id: 'navigate-to-account-summary',
      instruction: 'Look for "Account Summary" or "Funds" in the sidebar. Click on "Account Summary" to see your cash balances, buying power, and margin information.',
    },
    {
      id: 'export-account-summary',
      instruction: 'Look for "Export" or "Download" on the Account Summary page. Export as CSV or Excel for the most recent date.',
    },
  ],
  completionCriteria: [
    'Export complete',
    'Download started',
    'CSV downloaded',
    'Report generated',
    'File exported',
  ],
};
