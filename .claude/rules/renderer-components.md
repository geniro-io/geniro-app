---
description: Renderer components — reuse layers, no duplication, directory structure
globs:
  - "apps/ui/src/renderer/**"
---

# Renderer components — reuse & structure

## Layers (every styled element goes through them, in order)

1. **Token** in `styles/global.css` (see `renderer-design-system.md`)
2. **Primitive** in `components/ui/` — token-driven, shadcn-v4 flavour
   (`data-slot` attribute, `cva` variants, `cn()` composition):
   `button`, `input`, `textarea`, `select`, `label`, `card`, `badge`,
   `md-editor` (markdown editor with live preview — the port of geniro web's
   `components/ui/md-editor.tsx`; its GitHub-Primer chrome is retinted onto our
   tokens by `.md-editor-surface` in `styles/global.css`), `utils.ts` (cn)
3. **App-level shared component** in `components/` — composed from primitives:
   `logo`, `status-dot`, `field`, `note-box`, `error-text`, `empty-state`,
   `collapsible-card`, `agent-config-list`, `nav-rail`, `confirm-dialog`,
   `expandable-textarea` (a `Textarea` whose corner ⤢ opens the field in
   `markdown-editor-dialog` — use it for any prompt-length field instead of a
   bare `Textarea`), `markdown-editor-dialog`
4. **Feature screen** in its own directory: `chats/` (+ its row component
   `message-bubble.tsx`), `onboarding/`, `settings/`, `graphs/`, `terminals/`
   (the xterm.js mirror panel); app shell (`App.tsx`, `main.tsx`) and daemon
   clients at the renderer root — REST clients (`chat-api.ts`,
   `workflow-api.ts`, `terminal-api.ts`) extend the shared `daemon-rest.ts`
   transport (never re-implement `request()`); WS clients are
   `daemon-client.ts` + `terminal-client.ts`.

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
