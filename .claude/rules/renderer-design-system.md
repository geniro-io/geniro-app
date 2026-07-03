---
description: Renderer styling — design tokens only, never hardcoded colours
globs:
  - "apps/ui/src/renderer/**"
---

# Renderer design system — tokens & styling

The renderer is styled with **Tailwind CSS v4 (CSS-first `@theme`)** over a token
layer kept in lockstep with the sibling Geniro web app, so desktop and web look
identical.

- **`styles/global.css` is the ONLY source of design tokens** — the warm
  cream/caramel palette, radii, and shadows live in `:root` (raw values) +
  `@theme inline` (which maps them to `--color-*`/`--shadow-*` utilities), plus
  base typography. Components never define or hardcode any of these.
- **Never hardcode a colour.** Every colour/radius/shadow is read from a token:
  either a semantic utility (`bg-primary`, `text-muted-foreground`,
  `border-border`, `bg-sidebar-accent`, `shadow-panel-sm`) or `var(--token)`.
  A raw hex/`rgb()`/`hsl()`/`oklch()` — including inside a Tailwind arbitrary
  value like `bg-[#fff]` — is an **eslint error** (the `no-restricted-syntax`
  override scoped to `apps/ui/src/renderer/**` in `eslint.config.mjs`).
- **Non-colour arbitrary values are fine**: `ring-[3px]`, `size-[26px]`,
  `w-[220px]`, `shadow-[0_0_0_1px_var(--border)]`, `transition-[width]`.
- **Adding a token** = add it ONCE in `styles/global.css` (both `:root` and
  `@theme inline`), then reference it everywhere — never inline the literal at
  a call site. Keep token names/values aligned with
  `geniro/apps/web/src/styles/global.css` (the sibling repo) so palette fixes
  flow between the repos.
- **Compose classes with `cn()`** (`components/ui/utils.ts` — clsx +
  tailwind-merge); express variants with `cva` — never string-concatenate
  class names or branch with raw ternaries into long literals.
