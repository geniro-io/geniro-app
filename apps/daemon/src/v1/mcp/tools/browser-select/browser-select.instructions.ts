import {
  HOST_BROWSER_CLICK_TOOL,
  HOST_BROWSER_SNAPSHOT_TOOL,
  HOST_BROWSER_TYPE_TOOL,
} from '../../../agents/chat.types';
import { REFS, UNTRUSTED } from '../browser-shared/browser-instructions';

/** What a model reads about `browser_select`. */
export function browserSelectInstructions(): string {
  return (
    `Choose option(s) of a dropdown (a <select>) of a tab, by its ref from the latest ${HOST_BROWSER_SNAPSHOT_TOOL} and by option value or visible label. ` +
    `Use it when a form asks you to pick from a native dropdown. ${REFS} ` +
    `Do NOT use it for a dropdown drawn out of ordinary elements — click it open with ${HOST_BROWSER_CLICK_TOOL} and click the option — or to type into a field (use ${HOST_BROWSER_TYPE_TOOL}). ` +
    `${UNTRUSTED}`
  );
}
