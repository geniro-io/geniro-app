---
description: Renderer styling — design tokens only, never hardcoded colours
paths:
  - "apps/ui/src/renderer/**"
  - "apps/ui/.storybook/**"
---

# Renderer design system — tokens & styling

Style only from design tokens (Tailwind CSS v4, CSS-first `@theme`); never hardcode a colour.

## Tokens and themes

- `styles/themes/<id>.css` is the only source of token values, one file per theme. `styles/global.css` maps them to utilities in `@theme inline` and holds no value of its own. Components never define a token.
- Adding a token: add it to every file in `styles/themes/` and to the `@theme inline` map, then reference it. Keep the light theme's names and values aligned with the sibling repo's `geniro/apps/web/src/styles/global.css`.
- Every theme file declares the same tokens; a missing one silently falls back to light. `styles/themes/theme-tokens.spec.ts` catches it.
- Adding a theme: a file in `styles/themes/` plus a row in `shared/themes.ts` (id, label, appearance, window background). `shared/themes.spec.ts` fails if they disagree.
- The theme marker is `data-theme` on `<html>`, written only by `renderer/theme/apply-theme.ts`. Never use a `.dark` class or the OS media query; Tailwind's `dark:` is re-keyed onto `data-theme`. A component that must name the theme uses that module's hooks.

## Colours

- Every colour, radius and shadow comes from a semantic utility (`bg-primary`, `text-muted-foreground`, `shadow-panel-sm`) or `var(--token)`.
- Raw hex / `rgb()` / `hsl()` / `oklch()` / `oklab()` are banned. The `no-restricted-syntax` override in `eslint.config.mjs` catches them in Tailwind arbitrary values and `#hex` literals, but not a bare `rgb(…)`-style string (e.g. in `style={{}}`) — never write one.
- Non-colour arbitrary values are fine (`size-[26px]`, `shadow-[0_0_0_1px_var(--border)]`).
- Floating panels use the shared `popoverSurface` constant (`components/ui/popover.tsx`: `shadow-panel-lg` + `border-border/60` hairline). Panels that sit in the page (dialog) use `shadow-panel-md`.

## Class names

- Compose with `cn()` (`components/ui/utils.ts`) and express variants with `cva`; never string-concatenate classes or branch long literals with ternaries.
