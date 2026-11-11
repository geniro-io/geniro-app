import {
  HOST_BROWSER_CLICK_TOOL,
  HOST_BROWSER_PRESS_TOOL,
  HOST_BROWSER_SELECT_TOOL,
  HOST_BROWSER_SNAPSHOT_TOOL,
} from '../../../agents/chat.types';
import { REFS, UNTRUSTED } from '../browser-shared/browser-instructions';

/** What a model reads about `browser_type`. */
export function browserTypeInstructions(): string {
  return (
    `Type text into an input or textarea of a tab, by its ref from the latest ${HOST_BROWSER_SNAPSHOT_TOOL}, optionally pressing Enter afterwards with \`submit\`. ` +
    `Use it when filling a form field or a search box. ${REFS} ` +
    `Do NOT use it to send keys that are not text (Tab, Escape, arrows: use ${HOST_BROWSER_PRESS_TOOL}), to choose an option of a dropdown (use ${HOST_BROWSER_SELECT_TOOL}) or to press a button (use ${HOST_BROWSER_CLICK_TOOL}). ` +
    `${UNTRUSTED}`
  );
}
