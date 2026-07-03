# Custom Instructions

Project-specific rules and steps that apply to Geniro pipeline + discovery skills
(implement, plan, review, refactor, debug, onboard, investigate). Skills read this
file at the start of each run and at every phase-boundary refresh via
`${CLAUDE_PLUGIN_ROOT}/skills/_shared/load-custom-instructions.md`.

## Rules

- Run `pnpm full-check` before marking any task complete — it chains build →
  check-types → lint:fix → test:unit (build:tests / test:integration are no-op
  placeholders today). Never invoke `vitest` directly; always use the package.json
  scripts (`pnpm test:unit`, or `pnpm --filter <pkg> test:unit`).
- Never commit with `--no-verify`.
- No `any` — use specific types, generics, or `unknown` + type guards. ESLint
  enforces `@typescript-eslint/no-explicit-any: error`.
- **Always use CodeGraph for code exploration before grep/find/Read.** This repo
  is codegraph-indexed (`.codegraph/` at the root). Call `codegraph_explore` (MCP
  `mcp__codegraph__codegraph_explore`, or `codegraph explore "<query>"` in the
  shell) FIRST — one call returns verbatim line-numbered source plus dependents,
  replacing a multi-step grep+Read loop; treat returned source as already-Read (do
  not re-open those files). Grep/find stay correct for exact-literal / non-symbol
  text (log strings, config values, comments, copy) — codegraph is a CODE index
  only. The index it reads must be the worktree's own — the per-worktree index
  bootstrap runs at `## Additional Steps → After worktree-setup`.
- Vendored `@packages/{common,http-server,metrics,mikroorm}` track the sibling
  Geniro repo — keep changes minimal and local-first so fixes can flow between
  the two repos.
- **Renderer design system** — the UI (`apps/ui/src/renderer`) is Tailwind v4 +
  a token layer in `styles/global.css` that tracks the sibling Geniro web app.
  Two hard rules, enforced by an eslint override on `apps/ui/src/renderer/**`:
  (1) **never hardcode a colour** — every colour/radius/shadow comes from a token
  (`bg-primary`, `text-muted-foreground`, `var(--token)`); a raw hex/`rgb()`/`hsl()`,
  including inside a Tailwind arbitrary value (`bg-[#…]`), fails lint. (2) **never
  duplicate a component** — reuse a primitive in `components/ui/` or a shared
  component in `components/`; promote any recurring pattern into one rather than
  re-implementing it inline. New styling flows token → `components/ui/` primitive
  → `components/` app component (compose with `cn()`/`cva`, no barrels). Full
  contract in CLAUDE.md → *Design system (renderer)*.
- After moving native deps or switching ABIs, `pnpm rebuild:native` rebuilds
  better-sqlite3 against Electron's ABI.

## Additional Steps

### After worktree-setup

- **Create a worktree-local CodeGraph index when one is missing** — before any
  code exploration, and (if fanning out parallel subagents) in the orchestrator
  BEFORE spawning them, never inside each subagent (N concurrent `codegraph init`
  runs race on the index lock and serialize the fan-out behind one full build).
  codegraph resolves an index by walking UP parent directories to the nearest
  `.codegraph/`, so a command run inside a git worktree (e.g. an
  `isolation: 'worktree'` agent) silently borrows the MAIN checkout's index —
  which sits on another branch and is BLIND to changes made only in the worktree
  (codegraph never auto-creates or auto-syncs a worktree index).

    ```bash
    WT=$(git rev-parse --show-toplevel)
    MAIN=$(cd "$(dirname "$(git rev-parse --git-common-dir)")" && pwd)
    if [ ! -d "$WT/.codegraph" ] && [ -d "$MAIN/.codegraph" ]; then (cd "$WT" && codegraph init); fi
    ```

### Before ship
<!-- e.g. confirm `pnpm full-check` is green and the daemon smoke
     (boot apps/daemon/dist/main.js → GET /health/check → 200) passes -->

### After implement
<!-- -->

## Constraints

Hard local-first / security rules (also stated in CLAUDE.md):

- No cloud / remote / multi-machine code paths — everything runs locally.
- No Python runtime anywhere in the stack (including the CLI-agent layer).
- Secrets live in the macOS Keychain only — never in SQLite, never in a file
  (the per-launch loopback session token in `daemon.json` is allowed).
- The daemon binds loopback (`127.0.0.1`) only and gates every non-public route
  with the per-launch bearer token.
- Graph definitions are YAML (the source of truth); SQLite holds runtime/history
  only (`runs` / `items` / `node_state`).
