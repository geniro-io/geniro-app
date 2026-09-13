---
name: ticktick-implement
description: "Use when a TickTick task URL's items should be implemented in this repo one at a time, each verified in the real Electron dev app with before/after screenshots and an approval gate between items."
model: inherit
allowed-tools: [Read, Write, Edit, Glob, Grep, Bash, AskUserQuestion, mcp__ticktick__get_task_by_id, mcp__ticktick__get_comment, mcp__playwright__*, mcp__geniro-*__show_gallery]
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
2. Read the task, then fetch its screenshots.
   a. **Text — TickTick MCP, no browser.** Call `mcp__ticktick__get_task_by_id` with `<taskId>` for
      the title and content, and `mcp__ticktick__get_comment` with `<projectId>` + `<taskId>` for the
      discussion. Abort if the task has no content. Never open a browser for the text: MCP returns
      it directly and a browser round-trip only adds a login the text does not need.
   b. **Screenshots — the Playwright MCP browser, signed into TickTick.** The content embeds them
      as `![image](<attachmentId>/<uuid>.png)`; MCP returns no image bytes and the attachment URLs
      404 unauthenticated, so this half needs a browser that holds the user's TickTick session.
      Use `mcp__playwright__*` — asked for by name ("use playwright"): the Claude Chrome extension
      reports "not connected" in the headless turns geniro runs, so `mcp__claude-in-chrome__*` is
      not an option there, and `agent-browser` launches a throwaway profile that is signed out.
      (A deliberate exception to the repo-wide "browser automation is always agent-browser" rule in
      `.geniro/instructions/global.md`, which assumes a throwaway browser; the Electron half of this
      action, steps 5 and 6, still uses `agent-browser`.)
      Navigate to `<ticktick_task_url>` and confirm the session is live — the app renders the task
      (title `<project> - TickTick`) rather than redirecting to TickTick's or Google's sign-in page.
      If it is signed out, that is the ONLY case that involves the user: ask with `AskUserQuestion`
      to sign in in that Playwright window, wait for their confirmation, then re-check. Never enter
      credentials on their behalf and never ask before the check has failed.
      The attachments are the page's large `<img>` elements
      (`https://api.ticktick.com/api/v1/attachment/<projectId>/<taskId>/<id>.png`). To save one,
      navigate the tab TO that URL first — a `fetch` from the ticktick.com page is refused by CORS —
      then `browser_evaluate` a `fetch(location.href)` read into a `data:` URL through
      `FileReader`, with `filename` set to a path INSIDE this worktree (the tool refuses any other
      root), and decode the base64 in the shell. `browser_run_code_unsafe` cannot `import('fs')`,
      so it cannot write the file itself. Close the browser when the screenshots are saved.
   c. Save every screenshot under `.geniro/state/ticktick/<taskId>/ref-<n>.png` and read each one
      with the `Read` tool — the images define the expected result and the text alone does not. If a
      screenshot still cannot be retrieved, say which item is missing its evidence rather than
      guessing what it showed.
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
      `apps/ui/src/renderer/styles/themes/<id>.css` (one file per theme — a new token goes
      into EVERY one of them), never hardcoded, and shared UI is reused from
      `components/ui/` rather than re-implemented.
   c. Rebuild and relaunch the dev app so the running instance is the code just written
      (`pnpm build`, then kill the Electron process and repeat step 5's launch), then capture
      `agent-browser screenshot .geniro/state/ticktick/<taskId>/item-N-after.png`.
   d. Show the user both images with geniro's `show_gallery` tool — one call, full paths, before
      then after — plus their plain paths. NOT as markdown images: a path containing a space never
      renders as one in geniro's transcript, and every task worktree lives under
      `~/Library/Application Support/`, so `![before](<abs path>)` reached the user as raw text.
      Never `open` a screenshot into Preview.
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
