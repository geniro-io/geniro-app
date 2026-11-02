/**
 * The hover every clickable card shares: a background tint, nothing that moves
 * the card or changes its edge. The card draws its own resting ring (`ring-1`).
 */
export const CARD_HOVER_CLASS =
  'transition-colors duration-150 ease-out hover:bg-accent/50 motion-reduce:transition-none';

/** {@link CARD_HOVER_CLASS} on a card that is itself the button. */
export const CARD_BUTTON_CLASS = `${CARD_HOVER_CLASS} outline-none focus-visible:ring-2 focus-visible:ring-ring`;

/**
 * A library card drawn by `NavListItem`: a ring at rest, the shared hover, and
 * the focus ring of the button that fills it.
 */
export const NAV_CARD_CLASS = `rounded-card bg-card ring-1 ring-border ${CARD_HOVER_CLASS} has-[>button:focus-visible]:ring-2 has-[>button:focus-visible]:ring-ring has-[>button:focus-visible]:ring-offset-2 has-[>button:focus-visible]:ring-offset-background`;
