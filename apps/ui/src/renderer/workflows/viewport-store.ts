import type { Viewport } from '@xyflow/react';

/**
 * Per-workflow canvas viewport (pan x/y + zoom), persisted to localStorage on
 * every pan/zoom gesture and restored when the workflow reopens. View state
 * is personal UI state like the panel widths — it never belongs in the
 * shareable YAML, so it lives beside `geniro.builder.*` keys, keyed by slug.
 */
const KEY_PREFIX = 'geniro.builder.viewport.';

export function loadViewport(slug: string): Viewport | null {
  const raw = localStorage.getItem(KEY_PREFIX + slug);
  if (!raw) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object') {
      const { x, y, zoom } = parsed as Record<string, unknown>;
      if (
        typeof x === 'number' &&
        typeof y === 'number' &&
        typeof zoom === 'number' &&
        Number.isFinite(x) &&
        Number.isFinite(y) &&
        Number.isFinite(zoom) &&
        zoom > 0
      ) {
        return { x, y, zoom };
      }
    }
  } catch {
    // corrupt entry — fall through to null so the canvas falls back to fitView
  }
  return null;
}

export function saveViewport(slug: string, viewport: Viewport): void {
  localStorage.setItem(
    KEY_PREFIX + slug,
    JSON.stringify({ x: viewport.x, y: viewport.y, zoom: viewport.zoom }),
  );
}

/** Forget the view of a deleted workflow (a future same-slug workflow should
 *  open with a fresh fit, not a ghost of the old one). */
export function clearViewport(slug: string): void {
  localStorage.removeItem(KEY_PREFIX + slug);
}
