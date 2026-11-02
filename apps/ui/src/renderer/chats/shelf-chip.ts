/**
 * The composer shelf's look: separate chips with gaps, one per kind of thing,
 * and the status counters on the right drawn without a card.
 *
 * Constants rather than components: the chips are structurally different
 * elements — the pull request is an anchor, the folder chip a button, the
 * counters hover-popover triggers — so there is no one component to wrap them
 * in. They cannot live in `composer-shelf.tsx` either, which imports two of
 * their users: those would import it back, and a cycle through a `const` is a
 * temporal-dead-zone crash rather than a type error.
 */

/**
 * How tall EVERY item on the shelf is, carded or not. The row is
 * `items-center`, so items of different heights put their text at different
 * heights and the row reads as crooked.
 */
const SHELF_ITEM_HEIGHT = 'h-[22px]';

/** The CARD — the small surface with a hairline and a soft lift. */
const SHELF_CARD = 'rounded-md border border-border bg-card shadow-panel-sm';

/**
 * What is inside any of them — the box, the height, the type and the hover.
 *
 * The type is 11px and every glyph inside is drawn at `size-3` by the
 * descendant rule, so a chip's own `size-3.5` icon cannot outgrow the row.
 *
 * Two things that LOOK like measurements of this and are not, both learned the
 * expensive way. The spinner is a rotating ARC, so the bounding box of its INK
 * swings as the gap comes round — read 2px above the centre in one frame and
 * 2px below in another, which is noise rather than a misalignment to chase. And
 * a reading taken before a change is not comparable to one taken after unless
 * the HEIGHT is held fixed: the first pass here changed the height and the
 * leading together and read the height's own 1px shift as the leading's.
 */
const SHELF_BODY = `flex min-w-0 items-center gap-1 text-[11px] transition-colors hover:bg-sidebar-accent [&_svg]:size-3`;

/** A chip standing on its own — the default, and what most of the row is. */
export const SHELF_CHIP_CLASS = `${SHELF_BODY} ${SHELF_ITEM_HEIGHT} px-1.5 ${SHELF_CARD}`;

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
 * The part of a chip that GIVES WAY on a crowded shelf — a title, a label —
 * while the part that identifies the chip stays whole.
 *
 * `min-w-0` on a chip alone has no floor: a crowded shelf squeezed the
 * pull-request group to 2px beside two `shrink-0` action buttons, REPORTED as
 * an empty pill between the changes chip and the actions. So the chips that
 * shrink carry `min-w-min`, and their yielding part is wrapped in this: a grid
 * whose one track is `minmax(0, max-content)` asks for its whole content when
 * there is room and for NOTHING under a min-content squeeze, so the floor
 * `min-w-min` measures is exactly the parts outside it — the pull request's
 * number, the button's glyph. A `truncate` span cannot do this by itself: its
 * `nowrap` text is its min-content width, `min-w-0` or not.
 */
export const SHELF_YIELD_CLASS =
  'grid grid-cols-[minmax(0,max-content)] overflow-hidden';

/**
 * The right-hand cluster of status counters (tasks, notes, agents, sub-agents,
 * monitors, terminals, stages): glyph and figure only, the name in the tooltip.
 */
export const SHELF_STATUS_GROUP_CLASS =
  'ml-auto flex shrink-0 items-center gap-0.5 empty:hidden';

/**
 * A status counter's trigger: the chip's box and type without the card, so the
 * counters read as a status bar beside the content chips rather than as five
 * more cards competing with them.
 */
export const SHELF_STATUS_TRIGGER_CLASS = `${SHELF_BODY} ${SHELF_ITEM_HEIGHT} shrink-0 rounded-md px-1.5 aria-expanded:bg-sidebar-accent`;
