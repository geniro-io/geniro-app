/**
 * Whether a composer keystroke means "send this message".
 *
 * Enter sends and Shift+Enter inserts a newline — the convention every coding
 * CLI's own prompt uses, and the one users arrive with. Meta/Ctrl+Enter keeps
 * sending as well: it was the ONLY send chord before, so honouring it costs
 * nothing and spares the muscle memory it built.
 *
 * Shared by both composer textareas rather than inlined twice. They are separate
 * JSX subtrees calling different senders, and the send protocol is exactly the
 * part that must not drift between them — an Enter that sends in one composer
 * and newlines in the other is the defect.
 *
 * Two keystrokes deliberately do NOT send:
 *
 * - **Shift+Enter** — the newline, which is the whole point of the inversion.
 * - **An Enter closing an IME composition.** Confirming a candidate in a
 *   Japanese/Chinese/Korean input method is an Enter the composer never sees as
 *   text intent; sending there fires the message mid-word. `isComposing` is the
 *   platform's own answer to that question, and `keyCode === 229` is how older
 *   engines spell it — checked as well because `isComposing` is absent on a
 *   synthetic event, and a test that omits it must not be told to send.
 *
 * Callers run their menu-first protocol (`handleSkillMenuKeys`) BEFORE this, so
 * a bare Enter that picks a skill from the `/` autocomplete never reaches here.
 */
export function isComposerSendKey(event: {
  key: string;
  shiftKey: boolean;
  keyCode?: number;
  nativeEvent?: { isComposing?: boolean };
}): boolean {
  if (event.key !== 'Enter') {
    return false;
  }
  if (event.nativeEvent?.isComposing === true || event.keyCode === 229) {
    return false;
  }
  return !event.shiftKey;
}
