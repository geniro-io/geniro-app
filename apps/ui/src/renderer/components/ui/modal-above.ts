/**
 * Whether `node` is inside a modal dialog that does not hold `panel` — one
 * opened above it. Dialogs are portalled to the body, so a dialog opened from
 * content inside a floating panel is outside that panel in the DOM, and a press
 * in it must not count as a press outside the panel that opened it.
 */
export function isInModalAbove(panel: Element, node: Node): boolean {
  const element = node instanceof Element ? node : node.parentElement;
  const modal = element?.closest('[role="dialog"][aria-modal="true"]');
  return modal !== null && modal !== undefined && !modal.contains(panel);
}
