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
   `button`, `input`, `textarea`, `select`, `label`, `card`, `badge`, `utils.ts` (cn)
3. **App-level shared component** in `components/` — composed from primitives:
   `logo`, `status-dot`, `field`, `note-box`, `error-text`, `empty-state`,
   `collapsible-card`, `agent-config-list`, `nav-rail`
4. **Feature screen** in its own directory: `chats/` (+ its row component
   `message-bubble.tsx`), `onboarding/`, `settings/`, `graphs/`; app shell
   (`App.tsx`, `main.tsx`) and daemon clients (`chat-api.ts`,
   `daemon-client.ts`) at the renderer root.

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
