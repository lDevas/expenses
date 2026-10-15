# AGENTS.md

Guidance for coding agents working in this repository (OpenCode, Claude Code, Codex, and friends).
The [README.md](README.md) is the source of truth for product behavior — read its **Financial reconciliation** and **Ingestion** sections before touching `server/ingestion/` or `tests/`.

## What this is

A local personal-finance app. You upload exported bank, credit-card, and broker statements (no bank logins); the app parses them, reconciles money moving between your own accounts, and displays expenses, income, and investments.

## Stack

- Node.js **≥ 22.13** (24 LTS recommended). The API and CLI run TypeScript directly with `node --experimental-strip-types` — there is no server build step.
- Frontend: React 19 + Vite in `src/`. Backend: Hono + better-sqlite3 in `server/`.
- Lint: oxlint. Tests: node:test (unit/integration) + Puppeteer (browser).
- Ports: frontend `$CONDUCTOR_PORT` (default 5173; Vite proxies `/api` → 3456). API: `$SERVER_PORT` (default 3456). No `.env` file loading — env vars come from the process.

## Commands

| Command | What it does |
| --- | --- |
| `npm run run` | Start API + frontend together |
| `npm run server` | API only (auto-restarts on source changes) |
| `npm run dev` | Frontend only |
| `npm run build` | Typecheck + build frontend to `dist/` |
| `npx tsc -p tsconfig.server.json` | Typecheck the API |
| `npm run lint` | oxlint |
| `npm test` | Node tests (in-memory DBs; safe) |
| `npm run test:browser*` | Puppeteer UI tests (isolated test APIs; never touch your saved data) |
| `npm run reset-db` | **DESTRUCTIVE** — wipes all imported data. Only with an explicit user request. |

## Layout

- `src/pages/` Dashboard, Details, Investments, Ingestion · `src/components/` shared filters, charts, reports · `src/lib/` API client + finance/investment calculations
- `server/ingestion/parsers/` one parser per institution+statement · `server/ingestion/registry.ts` selects the parser from the institution's filename conventions · `server/ingestion/consolidation/` reconciliation rules · `server/db/` schema, migrations, queries · `server/pipeline.ts` parse → reconcile → persist · `server/server.ts` Hono API · `server/cli.ts` statement import/query CLI
- `tests/` node + browser regression tests · `data/` local SQLite DBs (gitignored)

## Hard rules

1. **`data/` contains real financial data** (SQLite DB, cookies, screenshots). Never read, quote, paste, or commit anything from it.
2. Parser selection depends on institution filename conventions (`estado_de_cuenta`, `umsatz`, `U1…csv`, `V_…pdf`, …) — don't rename fixtures or "normalize" filenames in tests.
3. Reconciliation semantics (transfers, FX, dividends, balance snapshots) are documented in the README and pinned by tests. Don't change financial behavior to make a failing test pass — fix the root cause.
4. Before finishing work, run: `npm run lint`, `npx tsc -p tsconfig.server.json`, `npm test`, and the browser tests covering what you changed (see README **Checks**).
