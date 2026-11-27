import type { RefObject } from 'react';

import { isInModalAbove } from './modal-above';

// A press inside a frame never reaches this document: focus entering the frame is all it leaves.
export function closeOnFrameFocus(
  panel: RefObject<HTMLElement | null>,
  close: () => void,
): () => void {
  const onWindowBlur = (): void => {
    const focused = document.activeElement;
    const current = panel.current;
    if (
      focused instanceof HTMLIFrameElement &&
      !current?.contains(focused) &&
      !(current && isInModalAbove(current, focused))
    ) {
      close();
    }
  };
  window.addEventListener('blur', onWindowBlur);
  return () => window.removeEventListener('blur', onWindowBlur);
}
