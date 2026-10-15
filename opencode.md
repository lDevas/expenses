# OpenCode project configuration reference

Companion document for [`opencode.json`](opencode.json) — this repo's project-level
OpenCode (V2) configuration. JSON cannot carry comments, so every field is
explained here instead.

## How OpenCode finds this file

OpenCode walks up from the working directory to the filesystem root, collecting
`opencode.json(c)` and `.opencode/opencode.json(c)` files, merging farthest
ancestor toward nearest (a `.opencode/` file beats a direct file for the same
key). This file sits at the repo root, so it applies to every OpenCode session
in this project — including Conductor workspaces, which are checkouts of the repo.

Your machine-level config (`~/.config/opencode/opencode.jsonc`) defines the LM
Studio provider and default model. When two files set the same key, the
**project file wins over the global one** — so this file deliberately does not
set `model` or `providers`, to avoid fighting your personal setup.

## What's in the file vs. documented only here

Fields whose documented default is a concrete value are written into
`opencode.json` at that exact default. Fields whose default is "unset" are
omitted on purpose (omission *is* the default — writing them could override
your personal global settings) and are documented below instead.

Three fields are intentionally **not** at defaults. Two are security features
for this personal-finance app with real data; one is a capability:

- `permissions` — denies read/write access to `data/` and asks before
  `git push` or `npm run reset-db`.
- `watcher.ignore` — keeps the file watcher off `data/**`, `dist/**`, `coverage/**`.
- `mcp.servers` — plugs in `browsermcp` for browser control (needs the
  Browser MCP browser extension on a local Chrome).

## All top-level fields

| Field | Type | Default | In file? | What it does (ELI5) |
| --- | --- | --- | --- | --- |
| `$schema` | string | — (convention) | ✅ `"https://opencode.ai/config.json"` | The file's spellchecker: points your editor at the official rules so it warns about typos and offers autocomplete. |
| `shell` | string | unset (your system shell) | omitted | Which terminal OpenCode opens to run commands — like choosing which kitchen to cook in. Example: `"/bin/zsh"`. |
| `model` | `provider/model` or object | unset (newest available supported model) | omitted | The "brain" used for new work. Your global file picks `lmstudio/LM-Studio-Model`; setting it here would override your personal choice, so it's left out. |
| `default_agent` | string | unset (built-in `build`) | omitted | Which assistant persona starts a session when none is picked (`build` = the coder, `plan` = the planner). |
| `update` | `"disable"` / `"notify"` / `"auto"` | `"notify"` | ❌ ignored in project files | How OpenCode updates its own software. Only honored in your global file — setting it in a repo file does nothing. |
| `share` | string | unset (no-op) | omitted | Would control session sharing. Accepted, but sharing isn't supported yet. |
| `username` | string | unset (no-op) | omitted | Would display a username in conversations. Accepted, but unused. |
| `permissions` | array of `{action, resource, effect}` | unset (built-in base policy) | ✅ **intentionally set** | The bouncer: for each action on each resource — `allow` = let it happen, `ask` = check with you first, `deny` = block. Details below. |

| `policies` | array of `{action, resource, effect}` | unset | omitted | A stricter bouncer that can only tighten, never loosen — for hard bans like `{"action": "tool.use", "resource": "shell:sudo *", "effect": "deny"}`. Broader config (yours, managed) always wins over repo config. |
| `agents` | object of agent definitions | unset (built-ins: `build`, `plan`, `general`, `explore`) | omitted | Custom assistant personas, each with its own job description, model, and rules. Options below. |
| `snapshots` | boolean | `true` | ✅ | Takes a save point of your files before each agent step, so `/undo` can roll a bad step back — an undo button that also remembers your files. |
| `formatter` | `true` / `false` / object | disabled (`false`) | ✅ | Auto-formats files after the agent edits them. `true` = enable every available built-in. Off here because this repo installs no formatter (oxlint is a linter, not a formatter). |
| `media` | object | `auto_resize: true`, 2000×2000 px, 5 MiB | ✅ | Shrinks oversized images before they reach the model — like auto-resizing a photo to fit an email attachment. Fields below. |
| `tool_output` | `{max_lines, max_bytes}` | `2000` / `51200` | ✅ | How much of a tool's result the model keeps in memory — a sticky-note size limit for command output. |
| `websearch` | `false` / `{provider}` | unset (asks you to pick a provider on first search) | omitted | Lets the agent search the web. Needs an API key (Exa, Firecrawl, Parallel, Tavily, TinyFish); omitted for a local-model setup. `false` = remove the tool entirely. |
| `mcp` | `{timeout, servers}` | no servers; 30 s / 30 s / 12 h timeouts | ✅ **intentionally set** | Pluggable external tool servers (MCP) the agent can use — like USB ports. One is plugged in: `browsermcp` (browser control, needs the Browser MCP browser extension). Fields below. |

| `compaction` | `{auto, keep, buffer}` | `auto: true`, `keep.tokens: 15000`, buffer = 10% of limit | ✅ (`auto` + `keep`) | When the chat nears the model's memory limit, summarize the older half to free space — like tidying a desk before it overflows. `buffer`'s default is a formula, so it's documented here only. |
| `warming` | `true` / `false` / object | disabled (`false`) | ✅ | Periodic "are you still there?" pings that keep provider-side caches warm. They cost real tokens — off, since a local model doesn't benefit. |
| `skills` | array of paths/URLs | unset (built-in discovery dirs) | omitted | Extra folders/URLs where OpenCode looks for reusable how-to guides (skills). Built-in discovery of `.opencode/skills/` etc. works without this. |
| `commands` | object of command definitions | unset (built-ins) | omitted | Slash-command shortcuts like `/review` — a name plus a prompt template. Options below. |
| `instructions` | array of files/URLs | accepted, **not loaded in V2** | omitted | Would point at extra instruction files, but V2 doesn't resolve them yet. The real instruction file in V2 is `AGENTS.md` — which this repo has. |
| `references` | object of named refs | unset | omitted | Named bookmarks to folders/repos outside this project that you can attach to a prompt. Fields below. |
| `worktree` | `{directory}` | unset (OpenCode data dir) | omitted | Where OpenCode puts new git worktrees (parallel checkouts). Rarely needed — Conductor manages workspaces on its own. |
| `plugins` | array of packages | none | omitted | Code packages that add features (new tools, hooks). Empty = vanilla OpenCode. |

| `providers` | object of provider definitions | models.dev catalog + local discovery (Ollama / LM Studio / vLLM) | omitted | Where models come from and how to talk to them. Your global file already defines `lmstudio`; the built-in also auto-discovers models from a local LM Studio at `127.0.0.1:1234`. |
| `experimental` | object | `portable_shell_scanner: false` | ✅ | Lab features. `portable_shell_scanner` swaps in a different command parser for permission checks (off = the default parser). |
| `watcher` | `{ignore: string[]}` | unset | ✅ **intentionally set** | Files the file watcher should pretend don't exist — `data/**` (real financial data), `dist/**`, `coverage/**` — so they don't trigger churn. |

## `permissions` — rule details

Each rule is `{ "action", "resource", "effect" }`:

- **`action`** — what's checked: `shell` (a command), `read` / `edit` (a file path), `glob` / `grep` (a pattern), `webfetch` / `websearch` (a URL / query), `subagent` / `skill` (an agent / skill ID), `external_directory` (access outside the workspace), or `<server>_<tool>` for MCP tools.
- **`resource`** — what it matches. `*` matches any run of characters (including `/`); `?` matches one character. A shell pattern ending in ` *` also matches the bare command (`git status *` matches `git status`).
- **`effect`** — `allow` / `ask` / `deny`.

Rules are evaluated in order and the **last match wins**: the built-in base
policy (allow all; ask for outside-workspace access and `.env` reads) runs
first, then this file's rules. The rules in `opencode.json`:

| Rule | Why |
| --- | --- |
| `read` / `edit` on `data` and `data/*` → `deny` | `data/` holds your real bank data (SQLite DB, cookies, screenshots). Blocking the model from even reading it keeps it out of chat logs, diffs, and PR descriptions. |
| `shell` `npm run reset-db*` → `ask` | Destructive — wipes every imported transaction; confirmation required. |
| `shell` `git push *` → `ask` | Pushing is a public act; confirm first (Conductor's PR flow does the pushing anyway). |
| `shell` `git status *`, `git diff *` → `allow` | Read-only inspection — always safe. |
| `shell` `npm run lint *`, `npm test *`, `npm run test:browser*`, `npm run build *` → `allow` | The repo's own checks; safe and encouraged (browser tests use isolated test APIs and never touch your saved data). |

A command not covered by any rule falls back to the built-in base policy
(allow; `.env` reads and outside-workspace access still prompt).

## `agents` — custom persona options

`agents` maps a name → definition. Built-ins: `build`, `plan`, `general`,
`explore` (plus hidden maintenance agents `compaction`, `title`, `summary`).
Each definition accepts:

| Option | Default | What it does (ELI5) |
| --- | --- | --- |
| `description` | — | A one-line job description, shown to the model when it decides which subagent to launch. |
| `mode` | `primary` | Where it runs: `primary` (main chat), `subagent` (only as a helper the main agent can launch), or `all`. |
| `model` | inherits the session's model | `provider/model` (+ optional `#variant`), or `{providerID, model, variant}`. |
| `system` | the provider's default persona | Replaces the agent's system prompt — its "personality manual". |
| `permissions` | inherits global rules (appended) | Its own bouncer rules, evaluated after the global ones. |
| `steps` | no limit | Maximum number of model steps; on the final step the agent must wrap up in plain text — a tool-call budget. |
| `hidden` | `false` | Hides it from pickers and listings (visibility only — use permissions for real restrictions). |
| `color` | — | A UI accent color, e.g. `"#ff6b6b"`. |
| `disabled` | `false` | Removes the agent (built-in or custom) from the available list. |
| `request` | — | Per-agent HTTP header / request-body overlays (V2 preserves these but doesn't send them yet — configure the provider/model instead). |

File-based alternative: `.opencode/agents/<name>.md` — YAML frontmatter (same
options) plus the Markdown body becomes the `system` prompt.

## `commands` — slash-command options

`commands` maps a name → definition. `/name args` expands the template and
submits it as a prompt:

| Option | Required | What it does (ELI5) |
| --- | --- | --- |
| `template` | ✅ in JSON | The prompt text; `$ARGUMENTS` / `$1`…`$n` are filled in from what you type after the command. |
| `description` | no | Shown in command listings so you remember what it does. |
| `agent` | no | Switches to this agent before running (e.g. `plan` = "think, don't build"). |
| `model` | no | A one-off model override for this command. |
| `subagent` | no | `true` = run in a background helper session; `false` = force the current session. |
| `subtask` | no | Deprecated alias for `subagent`. |

File-based alternative: `.opencode/commands/<name>.md` — the body is the
template, frontmatter holds the same options (but do **not** put `template` in
frontmatter). Templates may also embed `` !`shell command` `` blocks, which
run and paste their output into the prompt.

## `mcp` — server options

`mcp.timeout` sets defaults (milliseconds): `startup: 30000` (connecting),
`catalog: 30000` (listing tools), `execution: 43200000` (a tool call — 12 h).
`mcp.servers` maps a name → server.

**Local** (launched as a child process, talking over stdio):

| Field | Required | Default | What it does |
| --- | --- | --- | --- |
| `type` | ✅ | — | Must be `"local"`. |
| `command` | ✅ | — | The executable + arguments to launch, e.g. `["npx", "-y", "some-mcp-server"]`. |
| `cwd` | no | the workspace | Directory to launch from. |
| `environment` | no | inherited | Extra env vars; use `{env:NAME}` substitution (never hardcode secrets). |
| `disabled` | no | `false` | Keeps it configured but unconnected. |
| `codemode` | no | `true` | `false` = expose tools directly instead of via Code Mode. |
| `timeout` | no | the `mcp.timeout` defaults | Per-server overrides of startup / catalog / execution. |
| `protocol` | no | `"legacy"` | Which MCP protocol revision to speak: `legacy` / `auto` / `"2026-07-28"`. |

**Remote** (connects to a URL over Streamable HTTP):

| Field | Required | Default | What it does |
| --- | --- | --- | --- |
| `type` | ✅ | — | Must be `"remote"`. |
| `url` | ✅ | — | The absolute endpoint, e.g. `https://mcp.example.com/mcp`. |
| `headers` | no | — | HTTP headers; use `{env:NAME}` for keys. |
| `oauth` | no | `true` | `false` = no OAuth (when the server uses an API key instead). |
| `disabled` / `codemode` / `timeout` / `protocol` | no | same as local | same as local |

Pre-registered OAuth client fields (snake_case): `client_id`,
`client_secret`, `scope`, `callback_port`, `redirect_uri`,
`auth_server_metadata_url` — secrets via `{env:NAME}`.

Tools are named `<server>_<tool>`; hide or block one with a permission like
`{"action": "context7_*", "resource": "*", "effect": "deny"}`, or a policy
`integration.use` on `mcp:<server>`.

## `providers` & models

`providers` maps a provider ID → definition (the ID becomes the prefix in
`provider/model`):

| Field | What it does |
| --- | --- |
| `name` | Display name. |
| `env` | Ordered env-var names that can supply the credential (never hardcode secrets). |
| `package` | The runtime that talks to the API (e.g. `@opencode/ai/providers/openai-compatible`). |
| `canonical` | A built-in provider whose catalog defaults this one inherits. |
| `compatibility` | Request/response compatibility overrides (e.g. `reasoningField`, `cacheFormat`). |
| `settings` | Package options (e.g. `baseURL`, `apiKey: "{env:…}"`). |
| `headers` / `body` | Extra HTTP headers / request-body fields on every request. |
| `models` | Models to add or override, keyed by the ID used in `provider/model`. |

Model fields: `modelID` (the ID actually sent to the provider), `name`,
`family`, `package`, `settings`, `headers`, `body`, `capabilities`
(`tools`, `input`, `output`), `compatibility`, `variants` (named option sets,
e.g. reasoning effort), `cost`, `limit` (`context` / `input` / `output` token
counts), `disabled`.

For this repo: nothing is set — your global file already defines the LM Studio
provider, and the built-in `lmstudio` provider auto-discovers models from a
local LM Studio at `http://127.0.0.1:1234/v1`.

## The remaining knobs, in detail

| Field | Default | What it does (ELI5) |
| --- | --- | --- |
| `compaction.auto` | `true` | Auto-summarize the older chat near the context limit (also retries once if the provider rejects a request as too long). |
| `compaction.keep.tokens` | `15000` | How much of the recent chat to keep verbatim beside the summary. |
| `compaction.buffer` | 10% of the model's limit | How much headroom to keep free; larger = start compaction earlier. A formula, so it can't be written in the file. |
| `warming.prompt` | built-in "do nothing, reply OK" | The text of the keep-warm ping. |
| `warming.interval` | `"4 minutes"` | Idle time before the next ping. |
| `warming.duration` | `"30 minutes"` | The total window of pings after the last real activity. |
| `media.image.auto_resize` | `true` | `false` = reject oversized images instead of shrinking them. |
| `media.image.max_width` / `max_height` | `2000` px | The size a shrunk image is fit to (aspect ratio preserved). |
| `media.image.max_base64_bytes` | `5242880` (5 MiB) | The largest encoded image accepted. |
| `tool_output.max_lines` | `2000` | How many lines of a tool result are kept. |
| `tool_output.max_bytes` | `51200` | How many bytes of a tool result are kept. |
| `formatter.<name>` | inherits the built-in | Per-formatter overrides: `disabled`, `command` (argument array with `$FILE`), `environment`, `extensions`. |
| `references.<alias>` | — | `alias → "../path"` or `{path \| repository, branch, description, hidden}`. A string starting with `.`, `/`, or `~` is a local folder; a bare name (e.g. `"Effect-TS/effect"`) is a git repo. Attach the alias to a prompt to give the agent eyes on that folder; `description` tells the agent when it's relevant; `hidden` hides it from pickers. |
| `skills` | — | Extra search locations (paths or `https://` catalogs) on top of the built-ins: `~/.config/opencode/skills`, `~/.claude/skills`, `~/.agents/skills`, and project `.opencode/skills`, `.claude/skills`, `.agents/skills`. Each skill is a `SKILL.md` (frontmatter `name` + `description`) plus optional helper files; the model loads it on demand via the `skill` tool. |
| `worktree.directory` | OpenCode data dir | Parent folder for new local git worktrees (relative paths resolve against the project's canonical checkout; `~/…` and absolute paths work as-is). |

## TL;DR

- **`opencode.json`** — every OpenCode V2 field that has a concrete default,
  written at that default, plus the intentional `permissions` + `watcher`
  rules that protect your real financial data in `data/`.
- **`AGENTS.md`** — the instructions OpenCode (and Claude Code / Codex) load
  into every session automatically.
- **Your personal global file** — the LM Studio provider + model; the repo
  file never overrides it.

