import { type RefObject, useEffect, useLayoutEffect, useState } from 'react';

import type { BrowserBounds } from '../../../shared/contracts';
import { useAnyOverlayOpen } from '../../components/browser-occlusion';

function sameBounds(a: BrowserBounds | null, b: BrowserBounds | null): boolean {
  return (
    a === b ||
    (a !== null &&
      b !== null &&
      a.x === b.x &&
      a.y === b.y &&
      a.width === b.width &&
      a.height === b.height)
  );
}

/**
 * Keep the chat's native tab view over `placeholder`.
 *
 * `wanted` is whether a page should be showing at all. While any overlay is
 * open the view would sit above it, so a still of the page takes its place and
 * the view is hidden until the overlay closes.
 */
export function useBrowserView(
  runId: string,
  placeholder: RefObject<HTMLElement | null>,
  wanted: boolean,
): { still: string | null } {
  const overlayOpen = useAnyOverlayOpen();
  const [covered, setCovered] = useState(false);
  const [still, setStill] = useState<string | null>(null);

  useEffect(() => {
    if (!wanted || !overlayOpen) {
      setCovered(false);
      setStill(null);
      return;
    }
    let cancelled = false;
    void window.geniro
      .browserCapture(runId)
      .catch(() => null)
      .then((capture) => {
        if (!cancelled) {
          setStill(capture);
          setCovered(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [runId, wanted, overlayOpen]);

  const showing = wanted && !covered;

  useLayoutEffect(() => {
    const element = placeholder.current;
    if (!showing || element === null) {
      return;
    }
    let sent: BrowserBounds | null = null;
    const send = (next: BrowserBounds | null): void => {
      if (sameBounds(sent, next)) {
        return;
      }
      sent = next;
      window.geniro.browserSetBounds(runId, next).catch(() => undefined);
    };
    const measure = (): void => {
      const rect = element.getBoundingClientRect();
      send(
        rect.width > 0 && rect.height > 0
          ? {
              x: rect.left,
              y: rect.top,
              width: rect.width,
              height: rect.height,
            }
          : null,
      );
    };
    measure();
    window.addEventListener('resize', measure);
    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(measure);
    if (observer !== null) {
      observer.observe(element);
      const column = element.closest('[data-slot="browser-column"]');
      for (const neighbour of [
        column?.parentElement,
        column?.previousElementSibling,
      ]) {
        if (neighbour) {
          observer.observe(neighbour);
        }
      }
    }
    return () => {
      window.removeEventListener('resize', measure);
      observer?.disconnect();
      sent = null;
      window.geniro.browserSetBounds(runId, null).catch(() => undefined);
    };
  }, [runId, showing, placeholder]);

  return { still };
}
