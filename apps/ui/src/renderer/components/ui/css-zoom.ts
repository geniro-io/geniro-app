/**
 * The effective CSS `zoom` at `element`, 1 where nothing above it is zoomed. A
 * difference of two `getBoundingClientRect()` readings is in viewport pixels;
 * divide it by this before adding it to the element's own `scrollTop`.
 */
export function cssZoomOf(element: Element | null | undefined): number {
  const zoom = element?.currentCSSZoom;
  return zoom !== undefined && zoom > 0 ? zoom : 1;
}

/**
 * The `zoom` that undoes every CSS `zoom` above `element`, so a `fixed` panel
 * drawn beside it is placed and sized in viewport pixels, as it would be
 * anywhere else; undefined where nothing above it is zoomed.
 */
export function counterZoomOf(
  element: Element | null | undefined,
): number | undefined {
  const zoom = element?.currentCSSZoom;
  return zoom === undefined || zoom === 1 || !(zoom > 0) ? undefined : 1 / zoom;
}

/** {@link counterZoomOf} as a style to spread into a fixed panel's box. */
export function counterZoomStyle(element: Element | null | undefined): {
  zoom?: number;
} {
  const zoom = counterZoomOf(element);
  return zoom === undefined ? {} : { zoom };
}
