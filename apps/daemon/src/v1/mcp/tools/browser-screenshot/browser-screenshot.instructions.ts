import {
  HOST_BROWSER_SNAPSHOT_TOOL,
  HOST_GALLERY_TOOL,
} from '../../../agents/chat.types';
import { UNTRUSTED } from '../browser-shared/browser-instructions';

/** What a model reads about `browser_screenshot`. */
export function browserScreenshotInstructions(): string {
  return (
    `Take a picture of a tab. It is saved to disk at full resolution and its path comes back in the result; the user sees it in the chat. ` +
    `You do not see the picture unless you pass \`view: true\` (it is then put into the result at CSS-pixel size) or read the saved file — a picture costs far more of your context than text, so look only when you must judge it yourself. ` +
    `Use it when what matters is how the page LOOKS — layout, spacing, colours, a visual bug, a chart — or when the user asked for a screenshot; \`fullPage\` captures the whole page height, and \`width\` / \`height\` take it at a given window size (e.g. 1440×1280) whatever the browser pane's size. ` +
    `Do NOT use it to read text or find elements to act on (use ${HOST_BROWSER_SNAPSHOT_TOOL}: it is smaller and gives refs). ` +
    `To show it again in your own reply, put its saved path in a markdown image, or several in ${HOST_GALLERY_TOOL}. ${UNTRUSTED}`
  );
}
