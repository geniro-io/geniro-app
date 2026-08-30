---
description: Renderer styling — design tokens only, never hardcoded colours
paths:
  - "apps/ui/src/renderer/**"
---

# Renderer design system — tokens & styling

The renderer is styled with **Tailwind CSS v4 (CSS-first `@theme`)** over a token
layer kept in lockstep with the sibling Geniro web app, so desktop and web look
identical.

- **`styles/themes/<id>.css` is the ONLY source of design token VALUES** — one
  file per theme, each declaring the same set of custom properties (the warm
  cream/caramel palette, radii, shadows, font stacks). `styles/global.css`
  imports them and maps them to `--color-*`/`--shadow-*` utilities in
  `@theme inline`, which is pure indirection and written once for all themes;
  it carries no value of its own. Components never define or hardcode any of
  these.
- **Adding a THEME is a file in `styles/themes/` plus a row in
  `shared/themes.ts`** (id, label, light-or-dark appearance, window background
  — main needs that last one before any stylesheet exists, and cannot read a
  custom property). Two specs fail the build on a half-added theme: a token one
  file declares and another omits, or a row and a file that disagree.
- **Every theme file declares the same tokens.** A token missing from one theme
  does not fail — it falls through to `light.css`'s bare `:root` arm and paints
  a light value into a dark window, on one control. `styles/themes/
  theme-tokens.spec.ts` is what catches it; jsdom computes no CSS cascade, so
  no component spec can.
- **The theme marker is `data-theme` on `<html>`, written only by
  `renderer/theme/apply-theme.ts`** — never a `.dark` class and never the OS
  media query. `global.css` re-keys Tailwind's `dark` variant onto the same
  attribute so a `dark:` utility and a token cannot disagree: Tailwind's own
  default is `@media (prefers-color-scheme: dark)`, which reports the OS
  appearance rather than the theme, and those differ the moment a user pins
  Light on a dark-mode Mac. Do not add a second mechanism; a component that must
  NAME the current theme uses that module's hooks.
- **Never hardcode a colour.** Every colour/radius/shadow is read from a token:
  either a semantic utility (`bg-primary`, `text-muted-foreground`,
  `border-border`, `bg-sidebar-accent`, `shadow-panel-sm`) or `var(--token)`.
  A raw hex/`rgb()`/`hsl()`/`oklch()` — including inside a Tailwind arbitrary
  value like `bg-[#fff]` — is an **eslint error** (the `no-restricted-syntax`
  override scoped to `apps/ui/src/renderer/**` in `eslint.config.mjs`).
- **A FLOATING panel is lifted, not outlined** — `shadow-panel-lg` (the
  two-layer float: a tight contact shadow plus a wide ambient one) over a
  `border-border/60` hairline, and both come from the one `popoverSurface`
  constant in `components/ui/popover.tsx` that `Menu` and `Popover` share.
  Reported as a menu whose border "выглядит очень странно… топорно": on this
  warm near-white palette a full-strength border over `shadow-panel-md` made
  the border the strongest line on screen, so the panel read as a wireframe
  rectangle drawn on the page instead of a surface above it. `shadow-panel-md`
  stays for panels that sit IN the page (the dialog). The border is not
  dropped: no shadow reaches a panel's top edge, and near-white on near-white
  needs something there.
- **Non-colour arbitrary values are fine**: `ring-[3px]`, `size-[26px]`,
  `w-[220px]`, `shadow-[0_0_0_1px_var(--border)]`, `transition-[width]`.
- **Adding a token** = add it to EVERY file in `styles/themes/` plus the
  `@theme inline` map in `styles/global.css`, then reference it everywhere —
  never inline the literal at a call site. Keep the light theme's names/values
  aligned with `geniro/apps/web/src/styles/global.css` (the sibling repo) so
  palette fixes flow between the repos; the other themes are this app's own.
- **Compose classes with `cn()`** (`components/ui/utils.ts` — clsx +
  tailwind-merge); express variants with `cva` — never string-concatenate
  class names or branch with raw ternaries into long literals.
