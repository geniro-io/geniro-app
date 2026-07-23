---
name: run-desktop
description: Build, run, and drive the Geniro desktop UI on headless Linux (Claude Code on the web). Use when asked to run/start/screenshot the app or interact with its UI in a remote container. Drives the real renderer bundle in Chromium wired to a real daemon — the packaged Electron shell can't launch here.
---

Geniro is a macOS Electron app. In this remote Linux container the **packaged
Electron shell cannot launch** — the Electron binary download is blocked by the
egress policy (403 from github releases; report, don't route around it). So for
agent/automated use we drive the **same renderer bundle** the Electron window
loads, in the pre-installed **Chromium**, wired to a **real daemon** (spawned
under host Node), with `window.geniro` stubbed to hand the renderer a live
daemon handle + an onboarded state.

Everything is a REPL driver at `.claude/skills/run-desktop/driver.mjs`. Launch
is slow (~15s: daemon boot + the claude modes probe). Screenshots land in
`/tmp/shots/` (override with `SCREENSHOT_DIR`). All paths below are relative to
the repo root.

## Prerequisites (one-time per container)

```bash
# 1. Build the daemon (dist/) and the renderer (out/).
pnpm install
pnpm build

# 2. better-sqlite3 must match HOST Node's ABI — the daemon runs under host Node
#    here (Electron is unavailable). If you ever ran `pnpm rebuild:native` (which
#    targets Electron's ABI), put it back:
pnpm rebuild better-sqlite3

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
tmux send-keys -t georun 'nav Graphs' Enter
tmux send-keys -t georun 'ss graphs' Enter
tmux capture-pane -t georun -p                       # read command output
```

Then actually open `/tmp/shots/chats.png`. Blank frame = launch failed.

### Commands

| command | what it does |
|---|---|
| `launch` | boot daemon + warm probe + Chromium + stub, open the renderer |
| `caps` | print `GET /v1/capabilities` (the claude modes probe verdict) |
| `nav <Chats\|Graphs\|Settings>` | click a nav-rail item |
| `seed-workflow` | drop a demo workflow (an acceptEdits + an auto agent) — run AFTER `launch`, then `nav Graphs` |
| `fill <css-sel> <text>` | fill an input/textarea |
| `click <css-sel>` / `click-text <text>` | click (DOM click; coords not needed) |
| `send` | click the composer's Send button |
| `approve` / `deny` | answer a pending approval card |
| `ss [name]` | screenshot → `/tmp/shots/<name>.png` |
| `text [css-sel]` | print innerText |
| `options <css-sel>` | print a `<select>`'s `<option>` list |
| `js <expr>` | run an expression in the page (Playwright `page.evaluate`) |
| `quit` | close browser, kill daemon, exit |

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

The chat's cwd is a throwaway (`~/.tmp` via `GENIRO_RUN_CWD`, default
`$TMPDIR/geniro-run-cwd`), so tool calls never touch the repo.

## Gotchas

- **Electron shell won't launch — by policy.** The Electron binary download is
  a 403 (egress policy). Don't fight it; the renderer-under-Chromium path is the
  supported one here. On a real Mac, just `pnpm dev`.
- **Never `npm install` in this repo.** It's a pnpm workspace; npm prunes the
  hoisted `node_modules` and the daemon then can't find `reflect-metadata`.
  Repair with `pnpm install --force` (or `rm -rf node_modules && pnpm install`).
  Keep playwright-core in the side dir.
- **Daemon runs under host Node**, so better-sqlite3 must be host-ABI (see
  Prerequisites). `Cannot find module …better_sqlite3.node` / ABI mismatch =
  run `pnpm rebuild better-sqlite3`.
- **Native `<select>` menus can't be screenshotted open** (drawn by the OS, not
  the DOM). To show a dropdown's choices, set the value and screenshot each
  state, or read them with `options <sel>`.
- **Cross-origin to the daemon** works because the driver launches Chromium with
  `--disable-web-security` and the context with `bypassCSP` (the renderer's REST
  + Socket.IO hit the daemon on a different loopback port).

## Troubleshooting

- **`daemon exited code=1` / `Cannot find module`** → node_modules is damaged
  (npm-in-pnpm) or the daemon isn't built: `pnpm install --force && pnpm build`.
- **`playwright-core not found`** → `mkdir -p ~/.geniro-run-pw && npm i --prefix ~/.geniro-run-pw playwright-core`.
- **`WARN: app shell not detected`** → the renderer isn't built (`pnpm build`),
  or the daemon didn't come up (run `caps`, check the launch log).
- **Stale Xvfb/Chromium** (not usually needed — Chromium runs headless): kill
  leftover `chrome` procs; the driver's `quit` reaps the daemon it spawned.
