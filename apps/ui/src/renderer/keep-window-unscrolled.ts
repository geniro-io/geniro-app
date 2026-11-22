export function keepWindowUnscrolled(win: Window): () => void {
  const viewport = win.visualViewport;
  const root = win.document.documentElement;
  let layoutWidth = root.clientWidth;
  let fullHeight = viewport?.height ?? 0;

  const keyboardOrZoom = (): boolean => {
    if (!viewport) {
      return false;
    }
    if (root.clientWidth !== layoutWidth) {
      layoutWidth = root.clientWidth;
      fullHeight = viewport.height;
    }
    fullHeight = Math.max(fullHeight, viewport.height);
    // Chrome for iOS keeps the visual viewport shorter than the layout one with no keyboard, so only a drop below the tallest height seen means a keyboard.
    return (
      Math.abs(viewport.scale - 1) > 0.01 || viewport.height < fullHeight - 1
    );
  };

  const settle = () => {
    if (keyboardOrZoom()) {
      return;
    }
    if (win.scrollX !== 0 || win.scrollY !== 0) {
      win.scrollTo(0, 0);
    }
  };

  win.addEventListener('scroll', settle, { passive: true });
  viewport?.addEventListener('resize', settle);
  viewport?.addEventListener('scroll', settle);
  return () => {
    win.removeEventListener('scroll', settle);
    viewport?.removeEventListener('resize', settle);
    viewport?.removeEventListener('scroll', settle);
  };
}
