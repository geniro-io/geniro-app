---
description: Placement internals of the menu/popover/dialog primitives
paths:
  - "apps/ui/src/renderer/components/ui/menu.tsx"
  - "apps/ui/src/renderer/components/ui/popover.tsx"
  - "apps/ui/src/renderer/components/ui/dialog.tsx"
  - "apps/ui/src/renderer/components/ui/context-menu.tsx"
---

# Overlay primitives — placement internals

These are the contracts of `menu`, `popover` and `dialog`; the reuse layers they
belong to are in `renderer-components.md`.

- **A submenu moves before it shrinks, and nothing is measured before it is
  placed.** `menu`'s `side="right"` pins a panel's top to the row that opened it
  and grows down, so a row low in the window puts its tail off the bottom.
  Shortening is the wrong first answer: the height clamp is FLOORED at
  `MIN_MENU_HEIGHT`, so once the room under the row drops below the floor the
  panel overhangs anyway and the rows past the edge are unreachable. Shift up
  first and clamp only what is left (the genuinely taller-than-the-window case).
  A floating panel is placed in TWO commits, and the first one leaves the panel
  wherever the ancestor classes put it. The horizontal correction survives that
  by re-running and settling; `maxHeight` does not, because nothing lowers it
  again until the menu closes. **Any new correction in that effect must skip the
  unplaced commit**, or it freezes a measurement of a panel that was never where
  it was read.
- **`popover` keeps its panel INSIDE the window — it flips and it clamps.**
  `anchor="viewport"` places the panel `fixed` so no ancestor can clip it, which
  also means no ancestor can stop it from running off an edge. The requested side
  is kept whenever the panel fits, the other is taken only when it has more room,
  a panel too tall for either scrolls inside itself, and the across-axis offset is
  clamped so a wide panel cannot cross the far edge. Placement is TWO passes: the
  panel is not rendered until the trigger is measured, so the first pass cannot
  know its height, and an unmeasured height means "not known yet" rather than
  "fits nowhere".
- **`dialog` closes only the TOP dialog on Escape, and a control that answers
  Escape itself must say so.** Open dialogs share one stack and one `document`
  listener, and an Escape a control already `preventDefault`ed is left alone. A
  field whose Escape means "abandon THIS edit" calls `preventDefault()` +
  `stopPropagation()` (as `LabelEditor` and `menu.tsx`'s `consume()` do), or
  backing out of it closes the dialog underneath and loses its draft.
- **A container that CLIPS declares it, rather than each picker inside it
  coping.** `menu`/`popover` place panels absolutely, which any scrolling
  ancestor cuts — and `overflow-x: visible` cannot be restored on a box that
  scrolls vertically, since CSS forces both axes non-visible together. A scrolling
  container provides `MenuAnchorContext` as `viewport` (see `dialog`, whose body
  scrolls) and every menu inside measures its trigger and goes `fixed`. `Popover`
  takes the same decision per call site, as `anchor="viewport"`.
