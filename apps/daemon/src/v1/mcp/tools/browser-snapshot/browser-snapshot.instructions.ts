import {
  HOST_BROWSER_CLICK_TOOL,
  HOST_BROWSER_EVALUATE_TOOL,
  HOST_BROWSER_SCREENSHOT_TOOL,
  HOST_BROWSER_SELECT_TOOL,
  HOST_BROWSER_TYPE_TOOL,
} from '../../../agents/chat.types';
import { REFS, UNTRUSTED } from '../browser-shared/browser-instructions';

/** What a model reads about `browser_snapshot`. */
export function browserSnapshotInstructions(): string {
  return (
    `Read a tab as text: the page's structure — headings, links, buttons, fields — with an element ref (e12) on everything you can act on, and the visible text. ` +
    `Use it when you need to know what is on the page, or need a ref for ${HOST_BROWSER_CLICK_TOOL}, ${HOST_BROWSER_TYPE_TOOL} or ${HOST_BROWSER_SELECT_TOOL}. ${REFS} ` +
    `Do NOT use it to judge how the page looks — layout, colours, a rendering bug (use ${HOST_BROWSER_SCREENSHOT_TOOL}) — or to read a value the page's scripts compute (use ${HOST_BROWSER_EVALUATE_TOOL}). ` +
    `${UNTRUSTED}`
  );
}
