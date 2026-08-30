---
description: Renderer components — reuse layers, no duplication, directory structure
paths:
  - "apps/ui/src/renderer/**"
---

# Renderer components — reuse & structure

## Layers (every styled element goes through them, in order)

1. **Token** — its VALUE in `styles/themes/<id>.css` (one file per theme),
   mapped to a utility by `styles/global.css`'s `@theme inline` (see
   `renderer-design-system.md`)
2. **Primitive** in `components/ui/`, token-driven, shadcn-v4 flavour
   (`data-slot` attribute, `cva` variants, `cn()` composition). Browse the
   directory (`apps/ui/src/renderer/components/ui/`) for the current set —
   don't rely on a hand-maintained list here, which decays. Two rules worth
   stating rather than just browsing:
   - `chip` is the flat Cursor-style control chip: muted text, tight leading
     icon, fill only on hover — the SINGLE source of that look, which
     `select`'s `ghost` variant is built from, so a picker chip and a static
     chip cannot drift apart; a trailing `ChipChevron` is what marks a chip as
     a picker, so never put one on a static chip.
   - **`select` is NOT a native `<select>`**: macOS draws that as an Aqua
     popup whose menu is an OS surface — it ignores every token, cannot show
     headers/icons/checkmarks/search, and is invisible to the DOM, so it can be
     neither screenshotted nor asserted on. Pass `groups`, never `<option>`
     children; a test opens `[data-menu-trigger]` and reads `[role="option"]`.
   - **Every image the user can look at goes through `image-viewer`'s
     `ZoomableImage`** — the transcript's attachments, the composer's staged
     strip, an agent's markdown image. Three surfaces draw the same picture at
     three sizes, two of them `object-cover` crops, so "can I see the whole
     thing" has to be answered once. It is built ON `dialog` (Escape, backdrop,
     focus trap) and PORTALLED, since it opens from inside a transcript where
     `position: fixed` may be resolved against a transformed ancestor. A bare
     `<img>` is for chrome the user never inspects (`logo`).
   - **`ansi-text` is the ONE way command output is drawn**, over the pure
     `ansi.ts` parser beside it. A shell's escape sequences are not plain text:
     rendered verbatim the escape byte is invisible and its tail is not, so a
     coloured log reads as corrupted. Colours come from the `--ansi-*` tokens
     (never from the stream — a terminal palette is built for a black
     background), and anything that shows command output uses this rather than
     re-deriving which sequences to honour. The parser reports BRIGHTNESS as a
     flag beside the colour name and the component resolves it to a
     `--ansi-bright-*` token: what "brighter" looks like belongs to the theme,
     so it must not be computed as a lightened value in TypeScript.
   - `option-list` is the ONE way a set of pickable answer options is drawn,
     and its `arity` (`many` / `one` / `none`) is what decides the drawing —
     square boxes in a column for a checklist, round dots in a flow for a
     pick-one, and NO indicator at all where the click is itself the
     submission. Never reach for `chip` here: chips are `whitespace-nowrap`
     footer controls, and an option label is routinely a whole sentence.
   - **`popover` keeps its panel INSIDE the window — it flips and it clamps.**
     `anchor="viewport"` places the panel `fixed` so no ancestor can clip it,
     which also means no ancestor can stop it: a trigger on the last sidebar
     row opened a panel that ran off the bottom edge (reported). The requested
     side is kept whenever the panel fits, the other is taken only when it has
     more room, a panel too tall for either scrolls inside itself, and the
     across-axis offset is clamped so a wide panel cannot cross the far edge.
     Placement is TWO passes by necessity — the panel is not rendered until the
     trigger is measured, so the first pass cannot know its height, and an
     unmeasured height means "not known yet" rather than "fits nowhere".
   - **A container that CLIPS declares it, rather than each picker inside it
     coping.** `menu`/`popover` place panels absolutely, which any scrolling
     ancestor cuts — and `overflow-x: visible` cannot be restored on a box that
     scrolls vertically, since CSS forces both axes non-visible together. A
     scrolling container provides `MenuAnchorContext` as `viewport` (see
     `dialog`, whose body scrolls) and every menu inside measures its trigger
     and goes `fixed`. `Popover` takes the same decision per call site, as
     `anchor="viewport"`.
3. **App-level shared component** in `components/`, composed from primitives.
   Browse the directory (`apps/ui/src/renderer/components/`) for the current
   set. Rules worth stating rather than just browsing:
   - `error-banner` is the dismissible error STRIP: an `error-text` plus a
     close control and an optional recovery action. `error-text` alone belongs
     to a form field, where typing clears the message; a strip pinned to a
     screen needs a way out, because nothing the user can type will ever clear
     "could not load the workflow".
   - `copy-button` is the app's ONE clipboard control — it owns the
     copied-tick feedback and the write itself, so no caller re-implements
     either.
   - `mcp-dialog-button` is the ONE way an MCP listing is reached: a trigger
     (`icon` on a control row, `chip` beside other chips) opening
     `mcp-section` in a modal `dialog`. Ten server rows each able to carry a
     paragraph of connection-failure text do not fit in a panel band or a
     popover — both were tried. The OPEN state is the caller's, never the
     button's: the Agents panel keeps one open at a time across every card.
   - `use-persisted-flag` is the ONE way a boolean the user SET is remembered
     — a panel folded shut, a section left open. It reads like `useState`,
     updater form included, and keeps the value in localStorage beside the
     widths `panel-resize` already stores there. Reach for it whenever the
     owning component is remounted by its parent (the builder unmounts on every
     nav change; the agents panel is keyed by run id), which is exactly when
     `useState` silently forgets. A stored `'0'` is a CHOICE, not an absent
     key — that distinction is the hook's, so no call site re-derives it.
   - `panel-section` + `panel-link-row` are the side panel's titled block and
     its outward-link row (Artifacts, Pull requests). The row is a plain
     anchor opened by the SHELL — main's window-open handler routes https to
     the browser and denies every other scheme — so a new panel block composes
     these rather than copying their class strings.
   - `nav-list-item` is an activatable sidebar row; its `suspendActivation`
     prop drops the full-row overlay while a nested control — the chat row's
     inline rename field — owns the row's clicks and focus.
   - `expandable-textarea` is a `Textarea` whose corner ⤢ opens the field in
     `markdown-editor-dialog` — use it for any prompt-length field instead of
     a bare `Textarea`, EXCEPT one whose lifetime the surrounding component
     owns: the ⤢ modal cannot be dismissed from outside, and the control
     exposes no `ref` / `onKeyDown` / `onBlur` to commit through.
     `chats/queued-strip.tsx` is the standing example — the row it edits can
     be sent out from under the editor by the drain, so the strip has to
     close the field itself.
4. **Feature screen**, one directory per screen (`chats/`, `onboarding/`,
   `settings/`, `graphs/`, `notifications/`, `debug/`, …) — browse
   `apps/ui/src/renderer/` for the current set. `chats/` also holds its row
   component, `message-bubble.tsx`. App shell (`App.tsx`, `main.tsx`) and
   daemon clients live at the renderer root — the REST clients and every
   daemon wire type are GENERATED into `autogenerated/` (`pnpm generate:api`,
   never hand-edited) and reached through `createDaemonApis(handle)` in
   `daemon-api.ts`, which owns the base URL, bearer token, timeout and uniform
   error shape; WS clients are `daemon-client.ts`.

## Daemon types

- **Import every daemon wire type from `autogenerated`**, never restate one.
  `shared/contracts.ts` is Electron-internal (IPC, Settings, CLI detection,
  `DaemonHandle`) and must not grow daemon shapes.
- A concept the daemon does not expose over HTTP (the builder's `NodeKind`,
  `TRIGGER_KINDS`, `WorkflowLayout`) is DERIVED from a generated type where one
  exists — `WorkflowNode['kind']`, `Object.values(TriggerKind)`,
  `NonNullable<Workflow['layout']>` — so a daemon change surfaces as a type
  error rather than silent drift. Those derivations live in
  `graphs/node-schema.ts` and `graphs/graph-doc.ts`.
- After changing a daemon route or schema, run `pnpm generate:api` and commit
  the regenerated client with the change.

## Reuse rules

- **Never duplicate a component or pattern.** Before adding UI, reach for an
  existing primitive in `components/ui/` or shared component in `components/`.
- **Promote recurring patterns**: if a pattern (a button, field, status dot,
  card, error line, empty state…) appears in a second place, it becomes a
  shared component and is imported everywhere — never re-implemented inline.
  (Example: `agent-config-list` is shared by Onboarding AND Settings.)
- A new primitive belongs in `components/ui/`; a new app-specific composition
  belongs in `components/`; feature-only pieces stay in the feature directory.
- **Import directly** (`./ui/button`, `../components/field`) — **no barrels**
  (no `index.ts` re-export files).
- Keep screens thin: layout + state wiring; visual building blocks come from
  the shared layers.

## Component tests

- Co-located `*.spec.tsx` next to the component.
- Line 1 must be `// @vitest-environment jsdom` (the project default is `node`).
- When a `vi.mock(...)` factory closes over module-scope spies, wrap them in
  `vi.hoisted(() => ({ … }))`.
- Run via `pnpm --filter @geniro/ui test:unit` — never call `vitest` directly.
