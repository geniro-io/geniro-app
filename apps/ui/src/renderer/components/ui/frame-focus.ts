import type { RefObject } from 'react';

// A press inside a frame never reaches this document: focus entering the frame is all it leaves.
export function closeOnFrameFocus(
  panel: RefObject<HTMLElement | null>,
  close: () => void,
): () => void {
  const onWindowBlur = (): void => {
    const focused = document.activeElement;
    if (
      focused instanceof HTMLIFrameElement &&
      !panel.current?.contains(focused)
    ) {
      close();
    }
  };
  window.addEventListener('blur', onWindowBlur);
  return () => window.removeEventListener('blur', onWindowBlur);
}
