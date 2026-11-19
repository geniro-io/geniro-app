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
