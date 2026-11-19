/**
 * Give every element jsdom's missing `currentCSSZoom`, reading `zoom` as the
 * effective CSS zoom; answers the restore.
 */
export function stubCssZoom(zoom: number): () => void {
  const previous = Object.getOwnPropertyDescriptor(
    Element.prototype,
    'currentCSSZoom',
  );
  Object.defineProperty(Element.prototype, 'currentCSSZoom', {
    configurable: true,
    get: () => zoom,
  });
  return () => {
    if (previous === undefined) {
      delete (Element.prototype as { currentCSSZoom?: number }).currentCSSZoom;
    } else {
      Object.defineProperty(Element.prototype, 'currentCSSZoom', previous);
    }
  };
}
