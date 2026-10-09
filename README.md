# Expenses

A local personal-finance app that turns bank, credit-card, and broker statements into a consolidated view of expenses, income, and investments. Upload exported statements instead of connecting bank credentials; the app parses them locally, reconciles money moving between your accounts, and tracks which periods you have uploaded.

Built with React 19, TypeScript, and Vite, backed by a Hono API and SQLite.

## What you can do

- **Dashboard:** view income, expenses, net balance, and category breakdowns, filtered by period, account, currency, Expenses/Income, and category. UYU/USD conversion uses the latest exchange found in your statements; without a rate, totals stay in their original currencies. A net-worth card and two charts (bank net worth, and net worth including investment positions plus broker cash) step through the selected period using the balances reported in your statements; statements without balance data are listed rather than assumed zero.
- **Details:** inspect transactions and per-currency period totals using the same filters. The top of the page shows the same net-worth card as the Dashboard. Click a category to correct an individual transaction or create a matching rule. Use **Delete** to remove an unwanted transaction after confirmation; totals update immediately and repeat uploads won’t restore it. Original upload history is preserved.
- **Categories:** create, rename, and merge expense/income categories; edit, preview, reorder, disable, or delete description-matching rules.
- **Investments:** review consolidated positions, quantity-weighted purchase prices, account funding, dividends, realized profit/loss, and interest or charges across investment accounts. Positions use each account's latest snapshot on or before the selected period end, not live market prices.
- **Ingestion:** upload statement batches, inspect per-account coverage and possible missing periods, and browse consolidation history. Issue reports and transfer/currency-exchange reconciliation cover all bank, card, and investment accounts here. Run links select the corresponding upload batch’s reports.

## Getting started

### Requirements

- Node.js **22.13 or newer** (Node.js 24 LTS recommended) and npm. The API and CLI run TypeScript directly with Node's `--experimental-strip-types` flag.
- Statement exports in one of the supported formats below.

From the project root:

```sh
npm install
npm run run
```

Open **http://localhost:5173** (or the URL printed by Vite). This command starts both services:

| Service | Default URL | Purpose |
| --- | --- | --- |
| React/Vite frontend | `http://localhost:5173` | Browser interface; proxies `/api` requests to the backend |
| Hono API | `http://localhost:3456` | Statement parsing, consolidation, and persistence |

The database is created and initialized automatically at `data/expenses.db`; no separate database server or API key is required. Go to **Ingestion**, drop or select your statements, then review the uploaded results. Uploads start immediately. The API automatically restarts when its source files change, including statement parser updates. Stop both services with `Ctrl+C`.

To run the services in separate terminals:

```sh
# Terminal 1: API
npm run server

# Terminal 2: frontend
npm run dev
```

### Configuration

| Environment variable | Default | Effect |
| --- | --- | --- |
| `CONDUCTOR_PORT` | `5173` | Frontend port used by `npm run run` |
| `SERVER_PORT` | `3456` | API listening port |
| `API_URL` | `http://localhost:3456` | API address for server-backed CLI commands |
| `CORS_ORIGIN` | `*` | Allowed origin for API requests |

For example, `CONDUCTOR_PORT=5174 npm run run` changes the frontend port. The Vite API proxy targets port **3456** in [vite.config.ts](vite.config.ts); if you change `SERVER_PORT`, update that target too. These are process environment variables; the API does not automatically load a `.env` file.

## Supported statements

| Institution | Statement | Format |
| --- | --- | --- |
| Itaú Uruguay | Bank account | XLS |
| Itaú Uruguay | Visa/iLink credit card | PDF |
| Santander Uruguay | Bank account movements | XLS, CSV |
| Santander Uruguay | Visa credit card movements | XLS, CSV |
| Prex Uruguay | Bank account (multi-currency statement) | XLSX |
| Interactive Brokers | Activity statement | CSV |
| eToro | Account statement | XLSX |

Keep the institution's original export filenames: parser selection uses naming conventions such as `estado_de_cuenta`, `umsatz`, `CreditCards…`, `U1…csv`, `V_…pdf`, `etoro`, and `estado_cuenta` (Prex exports are recognized as one word; Itau's is two). Prex exports are also detected from their embedded document metadata, so a renamed `estado_cuenta`/`prex` XLSX is usually still recognized. Renaming a supported export can prevent correct detection. Arbitrary spreadsheets and PDFs are not supported; unrecognized files appear as issues in run history and do not create coverage.

## Ingestion

- Drop or select a global batch of PDF, CSV, XLS, or XLSX statements. Uploading starts immediately; the existing parsers detect the institution and account automatically.
- Each account has an aligned timeline (recent year by default, with an all-dates view), uploaded-through date, last upload, unique file count, and latest-run link. Expand its file history for individual uploaded ranges.
- Overlapping or adjacent file ranges merge. Every uncovered interval between them is shown as a **possible gap**. Accounts more than **30 days** behind today also show the outstanding period.
- Savings-account uploads cover complete calendar months, from the first day of the starting month through the last day of the ending month, even when activity or statement dates omit some days. This also applies to existing and legacy uploads without re-uploading; transaction and balance dates are unchanged.
- Checking, credit-card, and investment accounts use statement-header periods when available. Otherwise coverage is inferred from activity dates and labeled accordingly: an apparent gap is not proof that transactions are missing.
- Every batch is recorded in consolidation history, including repeat uploads and parsing issues. The current financial view is rebuilt from all saved parsed sources after each upload, so files uploaded separately reconcile together. Run details preserve the complete original result, including items already imported by another run.
- Existing databases migrate automatically on API startup, retaining all data and legacy ingestion/session tables. Older runs have inferred activity coverage; per-account filenames/counts were not recorded and cannot be recovered reliably.

### Financial reconciliation

- Duplicate/overlapping source rows are removed **before** pairing, dividend netting, and investment aggregation. Identical purchases within a statement remain distinct. Without a bank-provided transaction identifier, overlap matching uses financial fields plus occurrence number (the largest count in any one statement); identical transactions split across partial exports can be inherently ambiguous.
- Parsed sources and the current financial view are saved atomically with upload history. Dashboard, Details, and Investments use the current view; a history link opens that batch's statement report.
- Account balances only advance to valid newer snapshots. Internal transfers, card payments, and currency swaps are excluded from spending/income and Net Balance; third-party transfers remain included. FX conversion rates retain full precision.
- Own-account transfers reconcile across banks and between same-bank accounts, including different-currency legs and files uploaded separately. Ownership uses confirmed/discovered account numbers or counterparty names matching statement holders, never payment memos. Currency swaps need an account link or shared FX operation ID; equal dates alone are not enough. Bank fees remain expenses.
- Every received bank transfer additionally reconciles by value: it pairs with a bank transfer of the same value and currency on a different account within eight days of each other (a deposit can post days after the sender's entry), even when neither statement names the other account (e.g. `CRE. CAMBIOSOP…` / `CARGA TRANSFERENCIA BANCARIA` / `Transferencia SPI` between a bank account and a wallet). An explicit account number on either leg pins its true counterparty account and blocks the value match, and a value with two candidate legs in either direction stays in the financial items as ambiguous.
- Balance snapshots: savings/checking statements record their opening balance, each day's running balance, and closing balance; savings values date to the statement's calendar-month bounds, checking values keep their reported dates, and same-day values from overlapping exports keep the newest statement's. Archived sources saved before the balance step still carry the raw `saldo` values, so existing databases rebuild the current view once on the next API startup (data is retained). These snapshots feed the net-worth series on the Dashboard and Details; credit cards are excluded, and investment accounts are measured by positions plus broker cash on the Investments page.
- Transfers to/from other Itaú accounts (including `TRASPASO A/DE …ILINK`) remain regular expenses/income unless the counterparty is a known owned account. Sharing the same bank does not establish ownership.
- Broker wires can match generic Itau outgoing `DEB. CAMBIOSST…` and incoming `CRE. CAMBIOSOP…` entries without a broker name. Opposite-direction records must be within two days and identify a unique counterpart; competing generic candidates stay unmatched. Same-currency receipts may be lower than the sent amount by up to 1%, capped at 100 original-currency units (with a one-unit rounding allowance). Both reported amounts are preserved and their difference is shown as possible fees, not invented as a separate charge. Explicit fee rows remain expenses. Saved parsed sources are re-reconciled on the next API startup without rewriting upload history.
- Statement reports on the Ingestion page show transfer and currency-exchange reconciliation with both amounts, source files, and matched/unmatched filters. Missing sides are labeled in red. Missing or ambiguous counterparts stay visibly unmatched while identified own-account principal stays excluded from financial totals. Existing saved sources are automatically rebuilt once on startup when reconciliation rules change; historical run snapshots are preserved. Historical statement reports rebuild movements and financial items under current rules when their original archived files can be identified unambiguously, and apply proven own-account exclusions without changing those original audit snapshots.
- **Existing imports:** pre-upgrade uploads have no saved parsed sources. Their financial records and historical results are retained. Re-upload original statements to repair identifiable records and enable full reconciliation. For very old runs without content hashes, unidentifiable records remain retained and flagged for review; filenames alone are never treated as proof of identical content. No original bank files are modified.

Ingestion replaces the former Upload tab and browser-agent/session workflows. The legacy `/breakdown` route redirects to `/ingest`, preserving run query parameters.

Investment activity uses only accounts marked as investments, with period and account filters. Separate cards at the top show bank cash available to invest (checking/savings balances grouped by original currency) and uninvested broker cash (excluding securities and margin buying power). Cash uses the latest reported balances independently of the portfolio period; broker cash follows the account filter, while bank cash includes all bank accounts. Expand either card to see each account's balance and date. Missing cash balances remain unknown, not zero, and negative balances contribute no available cash.

Positions combine matching tickers across brokers using total cost basis and quantity-weighted purchase prices, taking each account's latest snapshot on or before period end. Account details expose the individual broker quantities, costs, and snapshot dates. Wires, dividend income (gross, withholding, and net), realized P/L, and interest/charges have separate tables filtered to the selected period; opening trades are excluded from realized P/L. A matched bank leg appears only as context for a broker wire, not as bank investment activity. Issue reports and reconciliation for all accounts live on Ingestion. `/insights` redirects to `/investments`.

## Categories and matching rules

Categories are user-defined labels, separate from the accounting types used for reconciliation. Labeling a transaction never changes its amount or turns an internal transfer, card payment, or currency exchange into spending or income. Expenses use negative amounts and Income uses positive amounts; investment income is included in the Income filter while retaining its separate dashboard chart. The All filters preserve each page's existing unfiltered behavior.

The Categories page manages an ordered list of regular-expression rules. For example, `UBER|CABIFY` matches either merchant and `^DIVIDEND` matches descriptions starting with DIVIDEND. Matching ignores case and accents and normalizes whitespace in descriptions. Rules can also be restricted to a reported transaction type, such as Fee, so a merchant name on a bank commission need not categorize it as a purchase. The first enabled matching rule wins. New rules start at the top; use the arrows to change precedence. Previews cover all saved transactions and show matches and category changes, with up to 50 examples. Invalid patterns cannot be saved.

Click a category in Details to save an individual correction, explicitly leave the transaction Uncategorized, return it to automatic rules, or create a matching rule. Individual corrections override rules and survive restarts and repeated statement imports. Creating a rule does not remove existing individual corrections. Category changes apply immediately to past and future transactions; parsed statements and historical upload snapshots are not rewritten. Changing the Expenses/Income filter clears the category selection, and filters apply to full-result totals as well as visible rows.

Starter categories and rules live in `server/categories/seed.json` and are imported once into SQLite. After initialization, the database is the source of truth: edits, merges, and deletions are not undone by restarting or updating the seed file. Only unused categories can be deleted; merge an in-use category into another of the same type to move its rules and corrections together. Unrecognized descriptions remain Uncategorized. The initial labels are deliberately granular and include provisional categories such as Bank debits/credits and Incoming/Outgoing transfers for descriptions with limited context.

The API exposes `/api/categories` (list/create), `/api/categories/:id` (rename/delete), `/api/categories/:id/merge`, `/api/category-rules` (list/create), `/api/category-rules/:id` (edit/delete), `/api/category-rules/order` (reorder), `/api/category-rules/preview`, and `/api/transactions/:id/category` (PUT correction, DELETE reset). PUT correction accepts `{ "categoryId": null }` for explicit Uncategorized. Transaction responses retain the original accounting `category` and add `categoryId`, `categoryName`, `categorySource`, and `matchedRuleId`.

`DELETE /api/transactions/:id` removes a transaction and its category correction from the current financial view, returning `{ "deleted": true }` or 404 if the transaction does not exist. Deletions persist through restarts and statement reconciliation; they do not rewrite historical upload snapshots or reported account balance snapshots.

## CLI

```sh
# Parse and save a batch directly, without running the API
node --experimental-strip-types server/cli.ts consolidate path/to/estado_de_cuenta.xls path/to/U123456.csv --db data/expenses.db

# These commands require the running API
node --experimental-strip-types server/cli.ts status
node --experimental-strip-types server/cli.ts accounts
node --experimental-strip-types server/cli.ts transactions --from 2026-09-01 --to 2026-09-30
```

Without `--db`, `consolidate` creates a separate `data/consolidate-<timestamp>.db` rather than updating the app's database. Use `--help` on the CLI or a subcommand to see its options. The former AI-ingestion and browser-session commands have been removed.

## Data and database maintenance

Statements are processed by the local API; no hosted service is needed for parsing or reconciliation. SQLite stores parsed sources, transactions, account balances, upload coverage, and historical run results. The ingestion pipeline does not modify your original statement files. Local database files are ignored by Git.

To back up your data, stop the API and copy `data/expenses.db` together with any `expenses.db-wal` and `expenses.db-shm` files present, or use SQLite's backup tooling.

To start over, stop the API and run:

```sh
npm run reset-db
```

**This deletes all locally imported data and run history**, then creates a fresh database. Restart the app and re-upload your statements afterward.

## Build

```sh
npm run build
```

The frontend build is written to `dist/`. To preview it locally, run `npm run server` in one terminal and `npm run preview` in another, then open the URL printed by Vite (normally `http://localhost:4173`). Preview inherits the configured `/api` proxy and still needs the API running on port 3456.

Vite preview is for checking the build, not production hosting. A deployed build needs the API running separately, `/api` requests routed to it, and a fallback to `index.html` for frontend routes. The Hono API does not serve `dist/` itself.

## Checks

```sh
npm run build
npx tsc -p tsconfig.server.json
npm test
npm run test:browser
npm run test:browser:details
npm run test:browser:currency
npm run test:browser:categories
npm run test:browser:investments
npm run test:browser:networth
node --experimental-strip-types tests/internal-transfers.browser.ts
npm run lint
```

Tests cover statement dates and balances, overlapping exports and repeated purchases, cross-upload reconciliation, investment deduplication, FX precision/direction, isolated dividends, financial exclusions, local-date filters, net-worth series and cards, API uploads, coverage/history, legacy migration, and transactional rollback. Persistence tests use in-memory databases. Browser checks use Puppeteer with isolated test APIs and do not change your saved database.

## Project structure

| Path | Contents |
| --- | --- |
| `src/pages/` | Dashboard, Details, Investments, and Ingestion screens |
| `src/components/` | Shared filters, charts, upload controls, and statement reports |
| `src/lib/` | API client, date filters, and finance/investment calculations |
| `server/ingestion/` | Statement parsers, account registry, and reconciliation rules |
| `server/db/` | SQLite schema, migrations, and queries |
| `server/pipeline.ts` | Parse, consolidate, and persist statement batches |
| `server/server.ts` | Hono API and database initialization |
| `server/cli.ts` | Command-line statement import and account queries |
| `tests/` | API, financial, persistence, and browser regression checks |
| `data/` | Local SQLite databases |
