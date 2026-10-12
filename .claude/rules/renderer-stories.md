---
description: Storybook story conventions for renderer components
paths:
  - "apps/ui/src/renderer/**/*.stories.tsx"
  - "apps/ui/.storybook/**"
---

# Component stories — mechanics

That every component has a co-located story is enforced by
`components/catalog-coverage.spec.ts` (see `renderer-components.md`); this file
holds how to write one.

- **`components/catalog-coverage.spec.ts` fails the suite** when a component has
  no story, when a story outlives its component, or when either is filed outside
  its layer's namespace (`Primitives/` for `ui/`, `Components/` for the root).
  It enforces DISCOVERABILITY, not de-duplication: no spec can see that two
  components do the same thing, only that both are in the catalog where the next
  person finds them before writing a third.
- Run the catalog with `pnpm storybook`, or from **View → Component Catalog** in
  a dev launch of the app. Storybook is dev-only and never packaged.
- A story that needs open/close state drives it from a stateful wrapper inside
  `render`, or opens by default — a story whose only state is "closed" shows an
  empty canvas and documents nothing.
- **A story that opens a MODAL gives its wrapper a height.** A dialog is `fixed`,
  so it fills whatever containing block it is given; a Docs page sizes each
  preview by its content (for a bare trigger, one row), squeezing the dialog to
  its title bar. Use `decorators: [(story) => <div className="h-[420px]">{story()}</div>]`,
  sized to what the dialog holds. `parameters.docs.story.inline = false` is NOT
  the fix — it changes nothing.
- **The catalog re-enables document scrolling, and must keep doing so.**
  `global.css` sets `html, body, #root { overflow: clip }` so the Electron shell
  can never be scrolled. `catalog.css` imports that file wholesale, so without its
  own override every Docs page longer than the viewport is frozen. Anything else
  the app's base layer does to the DOCUMENT is the same trap — the catalog is a
  scrolling web page, the app is not.
- `window.geniro` is stubbed by `renderer/__fixtures__/preload-stub.ts`, which
  answers plausible EMPTY state so a component shows its zero state rather than
  fabricated data. Populated data comes through PROPS.
- **That fixture is the ONE preload double** — the catalog installs it whole and a
  spec passes `overrides` for the channels it asserts on. It is TYPED as
  `GeniroApi` rather than cast, so a channel added to the interface stops it
  compiling; a spec that reaches `window.geniro` through
  `as unknown as Partial<GeniroApi>` defeats exactly that and must not.
