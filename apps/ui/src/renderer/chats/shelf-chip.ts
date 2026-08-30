/**
 * The composer shelf's look: separate chips, and ONE joined group among them.
 *
 * The chips are free-standing cards with gaps between them, and they stay that
 * way — a row of distinct readings about a thread, each its own object. What is
 * joined is the PULL REQUESTS and nothing else: the `All 4` control belongs to
 * the chips it counts, and standing apart from them as a fifth identical pill it
 * read as a peer of `Tasks 2/6`. REPORTED first as "let's join all chips somehow
 * to prs. like it should be more understandable", then — after the whole row was
 * joined into one bar — as "but chips still should be separate, as before. What
 * i told - ts only for prs".
 *
 * That is the shape of the fix: things that TOUCH are one thing, so touching is
 * a claim, and it must only be made where it is true. A bar holding every chip
 * claims the terminals and the pull requests are one statement, which they are
 * not; a group holding `#76` and `All 4` claims they are, which they are.
 *
 * Constants rather than components, and for the reason the first one had: the
 * chips are structurally different elements — the pull request is an anchor, the
 * workflow a button, the three counters are hover-popover triggers — so there is
 * no one component to wrap them in without taking each one's own behaviour away.
 * They also cannot live in `composer-shelf.tsx`, which imports two of the three:
 * those would have to import it back, and a cycle through a `const` is a
 * temporal-dead-zone crash rather than a type error.
 */

/**
 * How tall EVERY item on the shelf is — a chip, a segment of the group, and the
 * plain `All N` buttons alike.
 *
 * Stated once and shared, because the row is `items-center`: two items of
 * different heights are centred on each other rather than sharing a baseline,
 * so their text sits at two different heights and the row reads as crooked.
 * REPORTED as exactly that ("chips looks a bit not aligned, not in the middle,
 * content inside"), and measured in the running app at **24.5px for a chip
 * against 26px for the button beside it** — the chip took its height from its
 * content (`py-1` over a 15px line box plus 2px of border) while the button
 * already carried this literal, written out twice.
 *
 * It matters more INSIDE the group than beside it: two free-standing cards of
 * different heights are merely misaligned, while two segments of one card leave
 * a visible step in that card's own outline.
 */
const SHELF_ITEM_HEIGHT = 'h-[26px]';

/**
 * The CARD — the small white surface with a hairline and a soft lift.
 *
 * Worn by a standalone chip and by the pull-request GROUP alike, which is what
 * makes a joined run look like one chip rather than like a new kind of object:
 * whatever the group holds, the row still reads as cards with gaps between them.
 */
const SHELF_CARD = 'rounded-lg border border-border bg-card shadow-panel-sm';

/**
 * What is inside any of them — the box, the height, the type and the hover.
 *
 * `text-xs`'s own 15px line box is KEPT. `leading-none` was tried on the theory
 * that these labels carry no descenders, so their ink sits low in a box that
 * reserves descender space — and measured against the same height it moved the
 * ink by nothing at all (27.0 of 51 device rows either way). It buys no
 * alignment and costs a rule nobody could explain later, so it is gone.
 *
 * Two things that LOOK like measurements of this and are not, both learned the
 * expensive way. The spinner is a rotating ARC, so the bounding box of its INK
 * swings as the gap comes round — read 2px above the centre in one frame and
 * 2px below in another, which is noise rather than a misalignment to chase. And
 * a reading taken before a change is not comparable to one taken after unless
 * the HEIGHT is held fixed: the first pass here changed the height and the
 * leading together and read the height's own 1px shift as the leading's.
 */
const SHELF_BODY = `flex ${SHELF_ITEM_HEIGHT} min-w-0 items-center gap-1.5 text-xs transition-colors hover:bg-sidebar-accent`;

/** A chip standing on its own — the default, and what most of the row is. */
export const SHELF_CHIP_CLASS = `${SHELF_BODY} px-2 ${SHELF_CARD}`;

/**
 * What a `HoverPopover` chip puts on its WRAPPER, and what it puts on the
 * trigger inside it — the pair, because they do different jobs and only one of
 * them is obvious.
 *
 * `HoverPopover` renders a wrapper span around its trigger, and the WRAPPER is
 * what the shelf lays out; the trigger is a flex child of it. With `shrink-0`
 * on the trigger alone the wrapper collapsed under a crowded row while the
 * button inside refused to, so the button spilled out of its own box and the
 * next chip was placed against the collapsed one. REPORTED as "terminals chip
 * have some problems with margin" and measured at a 430px shelf: the
 * sub-agents span ran 725–810 against its own button's 725–837, with the
 * terminals span beginning at 816 — 21px INSIDE its neighbour. The gap does
 * not shrink there; it vanishes and the chips overlap.
 *
 * Stated once and shared by all three counter chips, which are otherwise
 * identical in this respect: three copies of the class pair is three chances
 * to fix one of them and leave the others overlapping.
 */
export const SHELF_CHIP_WRAPPER_CLASS = 'shrink-0';
export const SHELF_CHIP_TRIGGER_CLASS = `${SHELF_CHIP_CLASS} shrink-0`;

/**
 * ONE segment of {@link SHELF_GROUP_CLASS}.
 *
 * It carries no card of its own: a segment with its own hairline draws a second
 * line beside the divider, and one with its own radius leaves notches of the
 * group's background inside the run. What it keeps is the HOVER fill, because
 * hovering has to land on the one reading under the pointer rather than on the
 * group.
 *
 * `rounded-none` is an OVERRIDE and invisible until you look for it: it beats
 * `HoverPopover`'s own `rounded-full` on a trigger button, which the card's
 * `rounded-lg` used to win for the standalone chips. Take the radius away
 * without replacing it and the pill comes back, filling as a lozenge floating
 * inside a square segment.
 *
 * `px-2.5` rather than the chip's `px-2`. Two adjacent segments put their
 * padding back to back, so the value that reads as comfortable around a lone
 * card reads as cramped against a divider — the label needs its own room on
 * each side of the line, not half of it.
 *
 * `focus-visible:bg-sidebar-accent` is the keyboard's indicator here, because
 * the group's `overflow-hidden` CLIPS a focus ring — a ring is a box-shadow
 * drawn outside the element's box, so on the end segments most of it is cut
 * away. A fill is the element's own background and cannot be clipped.
 *
 * `overflow-hidden` on the SEGMENT is a different clip from the group's, and it
 * is what keeps a squeezed run readable rather than merely inside its box. A
 * pull-request chip is `[icon][number][title]` with the NUMBER deliberately
 * `shrink-0` — it identifies the thing, so it must never truncate — and under a
 * hard squeeze that unshrinkable content spilled out of its own segment and
 * printed over `All 4` beside it. Measured on a 430px shelf: two overlapping
 * strings where one was expected. The group's own clip cannot help, since the
 * two are SIBLINGS inside it. Clipping the number at its segment's edge is the
 * honest degradation — a cut-off number reads as "there is more here", where
 * overlapping glyphs read as a broken app.
 */
export const SHELF_SEGMENT_CLASS = `${SHELF_BODY} overflow-hidden rounded-none px-2.5 focus-visible:bg-sidebar-accent`;

/**
 * A JOINED run of segments, wearing one card — used for the pull requests, and
 * so far only for them.
 *
 * `divide-x divide-border` is the separation, and a hairline is all that is
 * needed: the segments are already spaced by their own padding, so the line
 * only has to say "a different one starts here". Tailwind's `divide-*` puts the
 * border on every child but the first, which is right for a run whose
 * membership changes — a chip that comes and goes takes its own divider with
 * it, and the leading edge is never doubled against the card's own border.
 *
 * `overflow-hidden` clips the end segments to the card's radius, so no segment
 * needs a corner rule of its own and the run stays correct however many it
 * holds. It does NOT clip the popovers: those are `anchor="viewport"`, so they
 * are `position: fixed`, and nothing here creates a containing block for them.
 */
export const SHELF_GROUP_CLASS = `flex min-w-0 items-center divide-x divide-border overflow-hidden ${SHELF_CARD}`;
