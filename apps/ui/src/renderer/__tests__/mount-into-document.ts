import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach } from 'vitest';

/**
 * The render function of a jsdom spec. Each call mounts the element into a
 * fresh container on the document, and every mount is unmounted and removed
 * after its test. Call it once at the top of the spec, outside any `describe`.
 */
export function mountIntoDocument(): (
  element: React.ReactElement,
) => HTMLDivElement {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    container?.remove();
    root = null;
    container = null;
  });
  return (element) => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root!.render(element);
    });
    return container;
  };
}
