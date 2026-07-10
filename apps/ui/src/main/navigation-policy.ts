/**
 * Keep the top frame on the renderer document. `URL.origin` is not sufficient
 * for packaged builds because every `file:` URL has the opaque origin "null".
 */
export function isAllowedTopFrameNavigation(
  targetUrl: string,
  currentUrl: string,
): boolean {
  try {
    const target = new URL(targetUrl);
    const current = new URL(currentUrl);
    if (current.protocol === 'file:') {
      return (
        target.protocol === 'file:' &&
        target.host === current.host &&
        target.pathname === current.pathname
      );
    }
    return target.origin === current.origin;
  } catch {
    return false;
  }
}
