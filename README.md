# Expenses

Bank and broker statement consolidation with per-account upload coverage.

## Development

```sh
npm install
npm run run
```

This starts the API on port 3456 and Vite on `CONDUCTOR_PORT` (5173 by default). Data is stored in `data/expenses.db`.

## Ingestion

- Drop or select a global batch of PDF, CSV, XLS, or XLSX statements. Uploading starts immediately; the existing parsers detect the institution and account automatically.
- Each account has an aligned timeline (recent year by default, with an all-dates view), uploaded-through date, last upload, unique file count, and latest-run link. Expand its file history for individual uploaded ranges.
- Overlapping or adjacent file ranges merge. Every uncovered interval between them is shown as a **possible gap**. Accounts more than **30 days** behind today also show the outstanding period.
- Statement-header periods are used when available. Otherwise coverage is inferred from activity dates and labeled accordingly: an apparent gap is not proof that transactions are missing.
- Every batch is recorded in consolidation history, including repeat uploads and parsing issues. The current financial view is rebuilt from all saved parsed sources after each upload, so files uploaded separately reconcile together. Run details preserve the complete original result, including items already imported by another run.
- Existing databases migrate automatically on API startup, retaining all data and legacy ingestion/session tables. Older runs have inferred activity coverage; per-account filenames/counts were not recorded and cannot be recovered reliably.

### Financial reconciliation

- Duplicate/overlapping source rows are removed **before** pairing, dividend netting, and investment aggregation. Identical purchases within a statement remain distinct. Without a bank-provided transaction identifier, overlap matching uses financial fields plus occurrence number (the largest count in any one statement); identical transactions split across partial exports can be inherently ambiguous.
- Parsed sources and the current financial view are saved atomically with upload history. Dashboard, Details, and the default Breakdown/Insights use the current view; a history link always shows that batch's original result.
- Account balances only advance to valid newer snapshots. Internal transfers, card payments, and currency swaps are excluded from spending/income and Net Balance; third-party transfers remain included. FX conversion rates retain full precision.
- **Existing imports:** pre-upgrade uploads have no saved parsed sources. Their financial records and historical results are retained. Re-upload original statements to repair identifiable records and enable full reconciliation. For very old runs without content hashes, unidentifiable records remain retained and flagged for review; filenames alone are never treated as proof of identical content. No original bank files are modified.

Supported parsers: Itau account XLS and Visa PDF, Santander account XLS/CSV and card XLS/CSV, Interactive Brokers CSV, eToro XLSX. Unsupported files remain visible as issues in the run history and do not create coverage.

Ingestion replaces the former Upload tab and browser-agent/session workflows. Breakdown and Insights show consolidated results; run-history links open the selected batch in Breakdown.

## CLI

```sh
node --experimental-strip-types server/cli.ts consolidate <files...> --db data/expenses.db
node --experimental-strip-types server/cli.ts status
```

`consolidate` works without an API server; `status` reads upload coverage from the running API. The former AI-ingestion and browser-session commands have been removed.

## Checks

```sh
npm run build
npx tsc -p tsconfig.server.json
npm test
npm run test:browser
npm run lint
```

Tests cover statement dates and balances, overlapping exports and repeated purchases, cross-upload reconciliation, investment deduplication, FX precision/direction, isolated dividends, financial exclusions, local-date filters, API uploads, coverage/history, legacy migration, and transactional rollback. All persistence tests use in-memory databases.
