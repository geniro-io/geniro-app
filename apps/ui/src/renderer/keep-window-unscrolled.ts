export function keepWindowUnscrolled(win: Window): () => void {
  const viewport = win.visualViewport;
  const settle = () => {
    // iOS WebKit shrinks innerHeight with the keyboard; clientHeight keeps the layout height.
    const keyboardOrZoom = viewport
      ? viewport.height < win.document.documentElement.clientHeight - 1
      : false;
    if (keyboardOrZoom) {
      return;
    }
    if (win.scrollX !== 0 || win.scrollY !== 0) {
      win.scrollTo(0, 0);
    }
  };
  win.addEventListener('scroll', settle, { passive: true });
  viewport?.addEventListener('resize', settle);
  return () => {
    win.removeEventListener('scroll', settle);
    viewport?.removeEventListener('resize', settle);
  };
}
