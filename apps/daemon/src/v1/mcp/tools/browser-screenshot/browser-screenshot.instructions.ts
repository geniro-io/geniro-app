import {
  HOST_BROWSER_SNAPSHOT_TOOL,
  HOST_GALLERY_TOOL,
} from '../../../agents/chat.types';
import { UNTRUSTED } from '../browser-shared/browser-instructions';

/** What a model reads about `browser_screenshot`. */
export function browserScreenshotInstructions(): string {
  return (
    `Take a picture of a tab. It is saved to disk, its path comes back in the result, and the picture itself is shown to you. ` +
    `Use it when what matters is how the page LOOKS — layout, spacing, colours, a visual bug, a chart — or when the user asked for a screenshot; \`fullPage\` captures the whole page height. ` +
    `Do NOT use it to read text or find elements to act on (use ${HOST_BROWSER_SNAPSHOT_TOOL}: it is smaller and gives refs). ` +
    `To show the picture to the user, put its saved path in a markdown image, or several in ${HOST_GALLERY_TOOL}. ${UNTRUSTED}`
  );
}
