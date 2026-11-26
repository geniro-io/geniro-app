/**
 * Shows a `popover="manual"` element in the browser's top layer, above every
 * stacking context on the page, unless it is there already. Where the platform
 * has no top layer it leaves the element where it stands.
 */
export function showInTopLayer(element: HTMLElement): void {
  if (
    typeof element.showPopover === 'function' &&
    !element.matches(':popover-open')
  ) {
    element.showPopover();
  }
}

/** {@link showInTopLayer}, moved over whatever entered the top layer after it. */
export function raiseInTopLayer(element: HTMLElement): void {
  if (typeof element.showPopover !== 'function') {
    return;
  }
  if (element.matches(':popover-open')) {
    element.hidePopover();
  }
  element.showPopover();
}
