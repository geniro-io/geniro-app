---
name: ticktick-implement
description: "Use when a TickTick task URL's items should be implemented in this repo one at a time, each verified in the real Electron dev app with before/after screenshots and an approval gate between items."
model: inherit
allowed-tools: [Read, Write, Edit, Glob, Grep, Bash, AskUserQuestion]
argument-hint: "[ticktick_task_url]"
risk_class: low
created: 2026-08-25
created-by: geniro:actions
---

# ticktick-implement

Take one TickTick task URL, read the task and every screenshot attached to it, split it into
discrete items, and implement them **one at a time** in this repo. Each item is proven in the
REAL Electron app — a dev instance launched with its own data directory — with a `before`
screenshot captured before the first edit and an `after` screenshot captured once the fix is in.
Both are shown to the user, and the run does not move to the next item without their approval.

## When to use

- You have a TickTick task URL collecting several UI defects or changes for geniro-app
- The task carries screenshots that define what "wrong" and "right" look like
- You want each fix demonstrated in the running app before the next one starts

## When NOT to use

- The change is a single obvious edit with no visual surface — use `/geniro:implement` directly
- The TickTick task is empty or has no actionable items (the run aborts at step 3)

## Steps

1. Resolve the task URL. If `[ticktick_task_url]` was passed positionally, use it; otherwise ask
   for it with the `AskUserQuestion` tool. Parse `#p/<projectId>/tasks/<taskId>` out of it — both
   ids are needed. Abort if the URL does not match that shape.
2. Open the task in the browser and read it, INCLUDING its images. Browser work is always the
   `agent-browser` CLI (never a built-in web tool): first `agent-browser skills get core`, then
   `export AGENT_BROWSER_SESSION="$(agent-browser session id --scope worktree --prefix ticktick)"`,
   then `agent-browser open "<ticktick_task_url>"` and `agent-browser snapshot -i`. Save every
   screenshot attached to the task under `.geniro/state/ticktick/<taskId>/ref-<n>.png` and read
   each one with the `Read` tool — the images define the expected result and the text alone does not.
3. Decompose the task into a numbered item list (one deliverable per item, in the order the task
   states them). Show the list and ask the user with `AskUserQuestion` to confirm the items and
   their order before ANY code changes. Abort if the task yields no actionable items.
4. Prepare the repo once, before item 1: `pnpm install`, `pnpm rebuild:native`, `pnpm build`, then
   `codegraph sync` (the index is not kept fresh on its own, and every code lookup in this action
   goes through `codegraph explore "<symbols>"` before grep/Read).
5. Launch the dev Electron app on its OWN data directory, so it neither collides with nor adopts
   the installed Geniro:
   ```bash
   DEV_DATA=$(mktemp -d /tmp/geniro-ticktick-XXXXXX)
   # Seed settings.json first — the folder picker is a native dialog CDP cannot answer.
   printf '%s' '{"onboardingComplete":true,"projectFolder":"'"$PWD"'","recentFolders":["'"$PWD"'"]}' \
     > "$DEV_DATA/settings.json"
   env -u ELECTRON_RUN_AS_NODE GENIRO_UI_USER_DATA="$DEV_DATA" \
     node_modules/.bin/electron apps/ui/out/main/index.js --remote-debugging-port=9333 &
   agent-browser connect 9333
   ```
   `env -u ELECTRON_RUN_AS_NODE` is required — a shell spawned by geniro inherits it, and Electron
   then starts as plain node and dies on `app.setName`. `GENIRO_UI_USER_DATA`
   (`apps/ui/src/main/index.ts:56`) redirects userData AND sessionData. Read
   `agent-browser skills get electron` before driving it.
6. For each item N, in order, one at a time:
   a. Navigate the dev app to the screen the item is about and capture the CURRENT state FIRST:
      `agent-browser screenshot .geniro/state/ticktick/<taskId>/item-N-before.png`. Capture it
      before the first edit — after the fix it cannot be recovered.
   b. Implement item N in this repo. Use `codegraph explore "<symbols>"` to locate code before
      grep/Read. Honour the renderer design system: colours come from tokens in
      `apps/ui/src/renderer/styles/global.css`, never hardcoded, and shared UI is reused from
      `components/ui/` rather than re-implemented.
   c. Rebuild and relaunch the dev app so the running instance is the code just written
      (`pnpm build`, then kill the Electron process and repeat step 5's launch), then capture
      `agent-browser screenshot .geniro/state/ticktick/<taskId>/item-N-after.png`.
   d. Show the user both images in the reply as markdown — `![before](<abs path>)` and
      `![after](<abs path>)` — plus their plain paths. Never `open` a screenshot into Preview.
   e. Ask with `AskUserQuestion`: "Item N — <title>. Approve and continue to item N+1?" with
      options `Continue`, `Redo this item` (loop back to 6b with their notes), `Stop here`. Do NOT
      start item N+1 without an explicit `Continue`. On `Stop here`, go to step 7 with the items
      completed so far.
7. Run `pnpm full-check` and report its result verbatim. Kill the dev Electron process and remove
   `$DEV_DATA`. Leave the screenshots on disk.

## Output

A per-item report: for each implemented item, its title, the files changed, and the before/after
screenshots rendered inline; ending with the `pnpm full-check` result and the list of any items
left unimplemented because the user stopped early.

## Test cases

- Run it against a TickTick task with two items: the run must pause for approval after item 1 and
  must not touch item 2's files until `Continue` is chosen.
- `item-1-before.png` and `item-1-after.png` both exist under `.geniro/state/ticktick/<taskId>/`
  and visibly differ — a `before` identical to `after` means the screenshot was taken after the
  edit, or the dev app was not rebuilt at step 6c.
