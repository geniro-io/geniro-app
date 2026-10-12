# Custom Instructions

Project-specific rules and steps that apply to Geniro pipeline + discovery skills
(implement, plan, review, refactor, debug, onboard, investigate). Skills read this
file at the start of each run and at every phase-boundary refresh via
`${CLAUDE_PLUGIN_ROOT}/skills/_shared/load-custom-instructions.md`.

## Rules

- Run `pnpm full-check` before marking any task complete (see AGENTS.md →
  *Before finishing any work*). Never invoke `vitest` directly; use the
  package.json scripts (`pnpm test:unit`, or `pnpm --filter <pkg> test:unit`).
- Project hard rules (no `--no-verify`, no `any`, typed query builders only, vendored
  packages kept minimal) are in AGENTS.md → *Coding conventions* / *Constraints
  (local-first & security)* and `.claude/rules/`.
- **Always use CodeGraph for code exploration before grep/find/Read — every code
  lookup, not just the first.** This repo is codegraph-indexed (`.codegraph/` at
  the root). Call `codegraph_explore` (MCP `mcp__codegraph__codegraph_explore`, or
  `codegraph explore "<symbol names>"` in the shell) FIRST and query by symbol
  names; treat returned source as already-Read. Grep/find stay correct for
  exact-literal / non-symbol text (log strings, config values, comments, copy) —
  codegraph is a CODE index only. Falling back to grep after one codegraph call is
  the failure mode this rule exists to prevent.
  - **A deferred MCP tool looks exactly like a missing one.** If
    `mcp__codegraph__codegraph_explore` is not in your tool surface, load its schema
    by name before concluding codegraph is unavailable — or use the shell form,
    which never needs loading.
  - **In a worktree, pass `projectPath: <absolute worktree root>`.** The MCP server
    keeps answering from the checkout the session was launched in, uncommitted work
    included, and never says which tree it read. A user-level hook may fill
    `projectPath` in; where it is absent, pass it yourself. The index must be the
    worktree's own — the bootstrap is `## Additional Steps → After worktree-setup`.
  - **Spawning subagents: pass this rule into each spawn prompt next to the task,
    not as a closing note.** A subagent inherits none of your context and its own
    workflow defaults to plain-text search, so a policy that arrives as a trailing
    aside loses to it.
- **Renderer design system** (`apps/ui/src/renderer`): colours, radii and shadows
  come from tokens, and reusable UI is a shared component — contracts in
  `.claude/rules/renderer-design-system.md` and `.claude/rules/renderer-components.md`;
  overview in AGENTS.md → *Design system (renderer)*.
- `pnpm rebuild:native` is a required step, not a conditional one — see
  AGENTS.md → *Daily development* for when and why.
- **Browser automation is `agent-browser` — the CLI, not a built-in tool.** Every
  browser-driven step of testing and development goes through it: driving the
  renderer, reproducing a UI bug, taking a verification screenshot, opening a
  tracker/issue page to read its attachments, or any web page at all. Load its
  usage guide first (`agent-browser skills get core`; `... get electron` for the
  Electron shell, `... get dogfood` for exploratory QA) — the CLI serves the docs
  for the installed version. Prefer it over playwright-mcp /
  `mcp__plugin_playwright_playwright__*` and over any other built-in web tool;
  those stay unused unless agent-browser genuinely cannot do the job. Use a named
  session
  (`export AGENT_BROWSER_SESSION="$(agent-browser session id --scope worktree --prefix <task>)"`)
  so a run cannot hijack the page a human or another agent left open in the
  shared default session. **One carve-out:** the run-desktop harness
  (`.claude/skills/run-desktop/`) owns its own Chromium driver (playwright-core)
  for headless/remote containers where Electron cannot launch.

- **Guard added on one path — sweep sibling paths for bypasses.** When a change
  adds a guard or cleanup obligation on one call path (a claim/release pair,
  validation, dedup, an auth check), before finishing sweep every sibling path
  that reaches the same protected operation — including failure branches that
  exit before the happy path completes — and confirm each one passes through
  the guard or releases the obligation.

- **"Verified" means observed on the instance the USER runs.** The observation
  must come from their launched app, the daemon their app is actually talking
  to, the real renderer bundle — never a daemon you booted yourself, a temp
  userData dir, or a spec you wrote to check with. Name the instance and how
  you reached it. A component spec is a proxy too, so renderer edits are NOT
  exempt — drive the real bundle. When the remaining step is the user's, say
  "waiting on <step>", never "fixed".
  - **Rebuild + relaunch is normally enough.** `pnpm dev` runs the daemon from
    `apps/daemon/dist/main.js`, and `DaemonSupervisor.startNow()` replaces a
    rebuilt daemon on its own: `mayAdopt` (`apps/ui/src/main/daemon-supervisor.ts`)
    compares the pidfile's recorded entry-file mtime+size against the build you
    just made, so a same-version rebuild moves the stamp and is replaced
    automatically. Its doc block holds the full mechanics.
  - **Fallback: kill the pid in `<userData>/daemon.json`, only when `isBusy` is
    false** and a stale daemon is still adopted because (a) the pidfile's
    `entry.path` is not the `dist/main.js` you just built (e.g. a
    `pnpm daemon:dev` daemon running TypeScript source holds the pidfile) or (c)
    either mtime stamp is unreadable. After a kill, relaunch, re-check, and state
    which build you observed.
  - **If `isBusy` is true or errors, do NOT kill.** The daemon is probably running
    another window's turn, and a killed in-flight turn is unrecoverable — which is
    why `DaemonSupervisor` refuses to replace a busy daemon. Say "waiting on <the
    busy run>" or ask the user.

## Additional Steps

### After worktree-setup

- **Give the worktree its own CodeGraph index** before any code exploration,
  and (if fanning out parallel subagents) in the orchestrator BEFORE spawning
  them, never inside each subagent: N concurrent `codegraph init` runs race on
  the index lock and serialize the fan-out behind one full build. codegraph
  resolves an index by walking UP parent directories to the nearest
  `.codegraph/`, so a worktree under `.claude/worktrees/` with no index of its
  own borrows the MAIN checkout's index, which is on another branch and blind to
  worktree-only changes. codegraph flags this with a banner on every result.

    ```bash
    WT=$(git rev-parse --show-toplevel)
    MAIN=$(cd "$(dirname "$(git rev-parse --git-common-dir)")" && pwd)
    if [ ! -d "$WT/.codegraph" ] && [ -d "$MAIN/.codegraph" ]; then
      (cd "$WT" && codegraph init)   # no index yet — one full build
    else
      (cd "$WT" && codegraph sync)   # catches the shell form up; MCP does its own
    fi
    ```

  MCP calls with `projectPath` catch the index up themselves; the shell form
  `codegraph explore` does no catch-up, so run `codegraph sync` before it after
  a batch of edits. Never use `init`/`index` to refresh: both are full rebuilds
  costing ~580 MB per checkout.

## Constraints

Hard local-first / security rules are stated once, in full, in AGENTS.md →
*Constraints (local-first & security)* — read that section rather than this one.
