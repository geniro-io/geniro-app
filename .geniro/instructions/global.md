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
- **Always use CodeGraph for code exploration before grep/find/Read — every code
  lookup, not just the first.** This repo is codegraph-indexed (`.codegraph/` at
  the root). Call `codegraph_explore` (MCP `mcp__codegraph__codegraph_explore`, or
  `codegraph explore "<query>"` in the shell) FIRST — one call returns verbatim
  line-numbered source plus dependents, replacing a multi-step grep+Read loop;
  treat returned source as already-Read (do not re-open those files). Falling back
  to grep after one codegraph call is the failure mode this rule exists to prevent:
  a good first result is not permission to revert to plain-text search for the rest
  of the run. Grep/find stay correct for exact-literal / non-symbol text (log
  strings, config values, comments, copy) — codegraph is a CODE index only. The
  index it reads must be the worktree's own AND freshly synced — an existing index
  is not a current one; the bootstrap + per-run sync run at `## Additional Steps →
  After worktree-setup`.
  - **A deferred MCP tool looks exactly like a missing one.** If
    `mcp__codegraph__codegraph_explore` is not in your tool surface, load its schema
    by name before concluding codegraph is unavailable — or use the shell form,
    which never needs loading.
  - **Spawning subagents: pass this rule into each spawn prompt next to the task,
    not as a closing note.** A subagent inherits none of your context and its own
    workflow defaults to plain-text search, so a policy that arrives as a trailing
    aside loses to it.
- Vendored `@packages/{common,http-server,metrics,mikroorm}` track the sibling
  Geniro repo — keep changes minimal and local-first so fixes can flow between
  the two repos.
- **Renderer design system** (`apps/ui/src/renderer`) — two hard rules: (1)
  never hardcode a colour, every colour/radius/shadow comes from a token in
  `styles/global.css` — enforced where possible, by an eslint override on
  `apps/ui/src/renderer/**`; (2) never duplicate a component, reuse a primitive
  in `components/ui/` or a shared component in `components/` — review-only, no
  mechanical enforcement exists for this one. Compose with `cn()`/`cva`. Full
  contract in CLAUDE.md → *Design system (renderer)*.
- `pnpm rebuild:native` is a required step, not a conditional one — see
  CLAUDE.md's Commands section (*Daily development*) for when and why.
- **Guard added on one path — sweep sibling paths for bypasses.** When a change
  adds a guard or cleanup obligation on one call path (a claim/release pair,
  validation, dedup, an auth check), before finishing sweep every sibling path
  that reaches the same protected operation — including failure branches that
  exit before the happy path completes — and confirm each one passes through
  the guard or releases the obligation. Both round-2 M3 self-review bugs were
  exactly this shape: the guard existed, a caller path bypassed it.

- **"Verified" means observed on the instance the USER runs.** The observation
  must come from their launched app, the daemon their app is actually talking
  to, the real renderer bundle — never a daemon you booted yourself, a temp
  userData dir, or a spec you wrote to check with. Name the instance and how
  you reached it. `pnpm dev` runs the daemon from `apps/daemon/dist/main.js`,
  and `DaemonSupervisor.startNow()` replaces a rebuilt daemon on its own:
  `mayAdopt` (`apps/ui/src/main/daemon-supervisor.ts`) compares the pidfile's
  recorded entry-file mtime+size against the one you just built, not the
  `package.json` version — its own doc block says "`version` cannot make this
  call" — so a same-version rebuild moves the stamp and IS replaced
  automatically. **Rebuild + relaunch is normally enough.** Fall back to
  killing the pid in `<userData>/daemon.json` only for the three cases where a
  stale daemon is still adopted: (a) the pidfile's `entry.path` is not the
  `dist/main.js` you just built — e.g. a `pnpm daemon:dev` daemon running
  TypeScript source holds the pidfile; (b) `isBusy` is true or errors (it
  defaults to busy on failure) — typically another window's run, and killing
  it costs that run; or (c) either mtime stamp is unreadable. After a kill,
  relaunch, re-check, and state which build you observed. A component spec is
  a proxy too, so renderer edits are NOT exempt — drive the real bundle. When
  the remaining step is the user's, say "waiting on <step>", never "fixed".

## Additional Steps

### After worktree-setup

- **Give the worktree a CodeGraph index, then SYNC it — every run, not only the
  first** — before any code exploration, and (if fanning out parallel subagents)
  in the orchestrator BEFORE spawning them, never inside each subagent (N
  concurrent `codegraph init` runs race on the index lock and serialize the
  fan-out behind one full build). codegraph resolves an index by walking UP
  parent directories to the nearest `.codegraph/`, so a command run inside a git
  worktree (e.g. an `isolation: 'worktree'` agent) silently borrows the MAIN
  checkout's index — which sits on another branch and is BLIND to changes made
  only in the worktree (codegraph never auto-creates or auto-syncs a worktree
  index).

  **Creating the index is not enough — it then rots.** Only the checkout holding
  `.codegraph/daemon.sock` is kept warm, so a worktree's index freezes at
  creation and drifts for days. `codegraph status` cannot be trusted to say
  so — `sync` is the only authoritative staleness check, so run it
  unconditionally rather than guarding on the index's absence.

    ```bash
    WT=$(git rev-parse --show-toplevel)
    MAIN=$(cd "$(dirname "$(git rev-parse --git-common-dir)")" && pwd)
    if [ ! -d "$WT/.codegraph" ] && [ -d "$MAIN/.codegraph" ]; then
      (cd "$WT" && codegraph init)   # no index yet — one full build
    else
      (cd "$WT" && codegraph sync)   # index exists but nothing keeps it warm
    fi
    ```

  One sync per worktree per session covers you **until you edit files** — a file
  written after the sync stays invisible, and a deleted file's symbols linger,
  until the next one. Re-sync after a batch of edits (or a merge/rebase) before
  trusting a lookup. Never reach for `init`/`index` to refresh: both are full
  rebuilds costing ~580 MB per checkout.

## Constraints

Hard local-first / security rules are stated once, in full, in CLAUDE.md →
*Constraints (local-first & security)* — read that section rather than this
one. This block used to restate them and had drifted into a lossy subset,
dropping four of CLAUDE.md's hard rules (ProcessRegistry registration, the
detached-child journal, "no tmux / PTY-scraping for graph execution", and the
`--no-verify` ban) — a pointer cannot drift the same way a second copy can.
