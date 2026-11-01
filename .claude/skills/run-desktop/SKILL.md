---
name: run-desktop
description: Build, run, and drive the Geniro desktop UI on headless Linux (Claude Code on the web). Use when asked to run/start/screenshot the app or interact with its UI in a remote container. Drives the real renderer bundle in Chromium wired to a real daemon — the packaged Electron shell can't launch here. On macOS, prefer `pnpm dev` with the real Electron shell first; use this Chromium harness as the fallback for headless/remote environments and for scripted/automated UI driving via its REPL.
---

Geniro is a macOS Electron app. **On macOS, the first choice is `pnpm dev`** —
it launches the real Electron shell against a real daemon, and needs nothing
in this skill. Use the harness below when there is no display to launch
Electron on (a remote/headless Linux container, where the Electron binary
download is a 403 from GitHub releases — egress policy; report it, don't route
around it), or when the task wants scripted, repeatable UI driving through a
REPL. It drives the same renderer bundle the Electron window loads, in the
pre-installed Chromium, wired to a real daemon (spawned under Electron's Node
where the Electron binary is installed, under host Node where it is not) with
`window.geniro` stubbed to hand the renderer a live daemon handle and an
onboarded state.

What this harness produces is exploration and automation evidence. It is NOT
"verified" in the sense of `.geniro/instructions/global.md`, which requires
observing the instance the user runs.

The REPL driver is `.claude/skills/run-desktop/driver.mjs`. Launch takes about
15s (daemon boot + the claude modes probe). Screenshots land in `/tmp/shots/`
(override with `SCREENSHOT_DIR`). All paths below are relative to the repo root.

## Prerequisites (one-time per container)

```bash
# 1. Build the daemon (dist/) and the renderer (out/).
pnpm install
pnpm build

# 2. better-sqlite3's ABI must match the runtime the driver spawns the daemon
#    under. The driver uses Electron's Node (ELECTRON_RUN_AS_NODE=1) whenever
#    node_modules/electron/dist holds the Electron binary — always on a Mac
#    after postinstall — and host Node only where the Electron download was
#    blocked (a typical headless Linux sandbox). Run the ONE that applies:
#    - Electron present → Electron ABI:
#        pnpm rebuild:native
#    - Electron absent → HOST ABI:
#        pnpm rebuild better-sqlite3
#      That is the opposite ABI to the unit tests': before any `pnpm test:unit` /
#      `pnpm full-check`, run `pnpm rebuild:native` again — the daemon and
#      mikroorm suites run under Electron and segfault on a host-ABI tree (the
#      UI suite runs under Electron too, for its Node APIs, but loads no sqlite).

# 3. playwright-core — install it OUTSIDE the repo. Do NOT `npm install` inside
#    this pnpm workspace: npm prunes pnpm's hoisted deps (reflect-metadata, …)
#    and breaks the daemon. A side dir is safe; the driver looks there.
mkdir -p ~/.geniro-run-pw && npm i --prefix ~/.geniro-run-pw playwright-core
```

The driver finds Chromium under `/opt/pw-browsers` and `claude` on `PATH`
automatically. (Override the playwright-core location with `GENIRO_PW=<dir>`.)

## Run (agent path)

```bash
tmux new-session -d -s georun -x 220 -y 50
tmux send-keys -t georun 'node .claude/skills/run-desktop/driver.mjs' Enter
timeout 20 bash -c 'until tmux capture-pane -t georun -p | grep -q "driver>"; do sleep 0.3; done'
tmux send-keys -t georun 'launch' Enter
timeout 70 bash -c 'until tmux capture-pane -t georun -p | grep -qE "app shell ready|WARN"; do sleep 0.5; done'
tmux send-keys -t georun 'ss chats' Enter          # screenshot the chats view
tmux send-keys -t georun 'nav Teams' Enter
tmux send-keys -t georun 'ss teams' Enter
tmux capture-pane -t georun -p                       # read command output
```

Then actually open `/tmp/shots/chats.png`. Blank frame = launch failed.

### Commands

| command | what it does |
|---|---|
| `launch` | boot daemon + warm probe + Chromium + stub, open the renderer |
| `caps` | print `GET /v1/capabilities` (the claude modes probe verdict) |
| `nav <Chats\|Teams\|Tasks\|Stats\|Settings>` | click a nav-rail item. Matches VISIBLE text, so the rail must be expanded — a collapsed item carries only `aria-label`/`title` and returns `NOT_FOUND` |
| `seed-team` | drop a demo team (an acceptEdits + an auto agent) — run AFTER `launch`, then `nav Teams` |
| `fill <css-sel> <text>` | fill an input/textarea |
| `click <css-sel>` / `click-text <text>` | click (DOM click; coords not needed) |
| `send` | click the composer's Send button |
| `approve` / `deny` | answer a pending approval card |
| `mdrag <from-sel> -> <to-sel>` | pointer drag from one element's centre to another's, in 12 steps — for React Flow edges, whose handles are not clickable and take no HTML5 drag |
| `ss [name]` | screenshot → `/tmp/shots/<name>.png` |
| `ss-el <name> <css-sel>` | screenshot of the first matching ELEMENT only → `/tmp/shots/<name>.png` (`ss-el: NOT_FOUND` if nothing matches) |
| `text [css-sel]` | print innerText |
| `options <css-sel>` | print an open menu's `[role="option"]` rows within the matched element (label, `aria-selected`, `disabled`) |
| `js <expr>` | run an expression in the page (Playwright `page.evaluate`) |
| `help` | list every command name |
| `quit` | close browser, kill daemon, exit |

Environment knobs, set before `node .claude/skills/run-desktop/driver.mjs`:

- `GENIRO_HEADED=1` — open a visible Chromium window instead of headless, so a
  human on a Mac can watch the session the driver is scripting.
- `GENIRO_RUN_PHONE=1` — a 393×852 touch viewport at 3× instead of the
  1360×900 desktop window, so the phone layout (below `sm`) is what renders.
- `GENIRO_RUN_SETTINGS=<json file>` — extra `settings.json` keys the stubbed
  `getSettings` answers with (saved run configurations, fast actions…); a write
  from the app still wins over them.
- `GENIRO_RUN_PRS=<json file>` — the thread's pull requests, keyed by PR URL,
  that the stubbed `getPullRequestsByRef` returns; seed from real
  `gh pr view --json` output.
- `GENIRO_RUN_GIT=dirty` — the stubbed git answers with a repo that has two
  branches and an unclean tree, instead of "not a repo".
- `GENIRO_FAKE_UPDATE=<version>[:<phase>[:<progress>]]` — make the stub report
  an app update, e.g. `1.47.0` or `1.47.0:downloading:0.62` (phase defaults to
  `available`), so the nav rail's update control can be driven.

Useful selectors: composer textarea `textarea[aria-label="Task for the new run"]`,
approval chip `[aria-label="Tool-approval mode"]`, Send `button[aria-label="Send"]`.

### Example: drive the approval-card round-trip

```
launch
fill textarea[aria-label="Task for the new run"] Use the Write tool to create note.txt containing hi. Call the tool directly.
send
# wait ~15s for the real claude turn to reach the Write permission…
ss approval-card
approve
ss approved
```

The chat's cwd is a throwaway (`GENIRO_RUN_CWD`, default
`$TMPDIR/geniro-run-cwd`), so tool calls never touch the repo.

**`GENIRO_RUN_CONFIG_DIR=<path>`** points every chat at a different agent CONFIG
directory — the profile holding that CLI's credentials, so a run can be driven
against a second account. Reach for it when the default profile is rate-limited:
the turn otherwise comes back as "You've hit your weekly limit" and proves
nothing about the code under test. It seeds the stubbed settings, so the
composer's profile chip shows it and every run created carries it.

## Gotchas

- **Never `npm install` in this repo** (Prerequisites step 3 — playwright-core
  lives in the side dir). Symptom: `daemon exited code=1` / `Cannot find module`
  → node_modules is damaged (npm-in-pnpm) or the daemon isn't built (step 1):
  `pnpm install --force && pnpm build`.
- **`Cannot find module …better_sqlite3.node`** / `NODE_MODULE_VERSION` mismatch
  at daemon boot → Prerequisites step 2.
- **This app has no native `<select>`** — every dropdown is `role="option"`
  DOM buttons behind `[data-menu-trigger]` (`menu.tsx`), which is exactly what
  makes one screenshottable and assertable open: click the trigger, then `ss`
  it or read its rows with `options <sel>`.
- **The browser flags are harness-only.** `--no-sandbox`,
  `--disable-web-security` and `bypassCSP: true` are what let the renderer's
  REST + Socket.IO cross loopback ports to the real daemon here; they must
  never be copied into app code or CI, and this browser must only ever load
  the locally-served renderer bundle — never a remote origin — since it can
  reach the daemon and its bearer token.
- **`playwright-core not found`** → Prerequisites step 3.
- **`WARN: app shell not detected`** → the renderer isn't built (`pnpm build`),
  or the daemon didn't come up (run `caps`, check the launch log).
- **Driving a real Electron window over CDP (macOS):** an occluded window
  delivers no `scroll` events and throttles `ResizeObserver`, so any
  measurement taken against it is meaningless. Assert
  `document.visibilityState === 'visible'` first, re-raising the window if
  needed (`osascript -e 'tell application "Electron" to activate'`). CDP
  `Input.dispatchMouseEvent` `mouseWheel` never acks under Electron and hangs
  the driver; stepped `scrollTop` writes emit real `scroll` events once the
  window is visible.
