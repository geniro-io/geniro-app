/**
 * The hover every clickable card shares: a lift, a shadow and a primary ring.
 * The card draws its own resting ring (`ring-1`).
 */
export const LIFT_HOVER_CLASS =
  'transition-[translate,box-shadow] duration-150 ease-out hover:-translate-y-px hover:shadow-panel-lift hover:ring-primary/40 motion-reduce:transition-none motion-reduce:hover:translate-y-0';

/** {@link LIFT_HOVER_CLASS} on a card that is itself the button. */
export const LIFT_BUTTON_CLASS = `${LIFT_HOVER_CLASS} outline-none focus-visible:ring-2 focus-visible:ring-ring`;

/**
 * A library card drawn by `NavListItem`: a ring at rest, the shared lift on
 * hover, and the focus ring of the button that fills it.
 */
export const LIFT_CARD_CLASS = `rounded-card bg-card ring-1 ring-border hover:bg-card ${LIFT_HOVER_CLASS} has-[>button:focus-visible]:ring-2 has-[>button:focus-visible]:ring-ring has-[>button:focus-visible]:ring-offset-2 has-[>button:focus-visible]:ring-offset-background`;
