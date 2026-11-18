import { useLayoutEffect, useState } from 'react';

/** An element's client size, kept current by a `ResizeObserver`; 0×0 until it is measured. */
export function useElementSize<T extends HTMLElement = HTMLDivElement>(): [
  (el: T | null) => void,
  { width: number; height: number },
] {
  const [element, setElement] = useState<T | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    if (element === null) {
      return;
    }
    setSize({ width: element.clientWidth, height: element.clientHeight });
    if (typeof ResizeObserver === 'undefined') {
      return;
    }
    const observer = new ResizeObserver((entries) => {
      const rect = entries.at(-1)?.contentRect;
      if (rect !== undefined) {
        setSize({ width: rect.width, height: rect.height });
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return [setElement, size];
}
