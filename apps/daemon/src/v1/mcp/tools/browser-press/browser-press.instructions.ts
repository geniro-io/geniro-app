import {
  HOST_BROWSER_CLICK_TOOL,
  HOST_BROWSER_TYPE_TOOL,
} from '../../../agents/chat.types';
import { UNTRUSTED } from '../browser-shared/browser-instructions';

/** What a model reads about `browser_press`. */
export function browserPressInstructions(): string {
  return (
    `Press a key or key chord in a tab: Enter, Escape, Tab, ArrowDown, Control+A. ` +
    `Use it when a page needs a keyboard action that is not typing text — closing a dialog, moving focus, confirming a choice. ` +
    `Do NOT use it to enter text (use ${HOST_BROWSER_TYPE_TOOL}) or to click something (use ${HOST_BROWSER_CLICK_TOOL}). ` +
    `${UNTRUSTED}`
  );
}
