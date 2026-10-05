/**
 * Put text on the clipboard, from any page the renderer runs in.
 *
 * Use this, never `navigator.clipboard`: the Clipboard API exists only in a
 * secure context, and the phone reaches this renderer over the LAN gateway's
 * plain http, where it is undefined. There the copy goes through a hidden
 * textarea and `execCommand('copy')`, which still works — but only inside the
 * user's gesture, so a caller copies from its click handler, before awaiting
 * anything.
 */
export async function writeClipboard(text: string): Promise<void> {
  // eslint-disable-next-line no-restricted-properties -- the one sanctioned use
  const clipboard = navigator.clipboard as Clipboard | undefined;
  if (clipboard?.writeText) {
    await clipboard.writeText(text);
    return;
  }
  const previous = document.activeElement;
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  // Pinned in view so focusing it scrolls nothing, and 16px because iOS
  // zooms the page into any focused field set smaller.
  area.style.top = '0';
  area.style.left = '0';
  area.style.fontSize = '16px';
  area.style.opacity = '0';
  area.style.pointerEvents = 'none';
  document.body.appendChild(area);
  try {
    area.focus({ preventScroll: true });
    area.select();
    // iOS Safari does not select a readonly field's text from `select()`.
    area.setSelectionRange(0, text.length);
    if (!document.execCommand('copy')) {
      throw new Error('the browser refused to copy');
    }
  } finally {
    area.remove();
    if (previous instanceof HTMLElement) {
      previous.focus({ preventScroll: true });
    }
  }
}
