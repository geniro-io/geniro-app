import { recordOf, resultTextOf, toolCallArgsOf } from './tool-result-text';
import type { ToolPair } from './transcript-groups';

/**
 * What a `browser_screenshot` call and its result say, read off the transcript.
 *
 * TWIN PARSER: `apps/daemon/src/v1/mcp/tools/browser-screenshot/` words the
 * result and saves the picture through `AttachmentStoreService.saveDownloaded`;
 * its text carries one line, `Saved screenshot: <absolute path>`. The call's
 * `tab` is the schema's field of that name. The call and result payloads are
 * `z.unknown()` on the wire BY DESIGN, so this is an independent reading of one
 * shape, and the line's wording is changed on both sides or neither.
 *
 * What the row holds is a PATH, never the picture: the card resolves it through
 * the loader a markdown image already uses.
 */
export interface BrowserScreenshot {
  /** The tab the call named (`t2`), or null when it named none. */
  tab: string | null;
  /** The saved file, or null while the call runs or when its result names none. */
  path: string | null;
  /** The call's failure or any other answer that is not a saved picture; null otherwise. */
  note: string | null;
  failed: boolean;
}

const SAVED_LINE = /^Saved screenshot: (\/.+)$/m;

/** The absolute path in a result's `Saved screenshot:` line, or null. */
export function savedScreenshotPath(text: string): string | null {
  return SAVED_LINE.exec(text)?.[1]?.trim() ?? null;
}

export function readBrowserScreenshot(pair: ToolPair): BrowserScreenshot {
  const tab = toolCallArgsOf(pair.call.payload)?.tab;
  const base = { tab: typeof tab === 'string' && tab !== '' ? tab : null };
  if (pair.result === null) {
    return { ...base, path: null, note: null, failed: false };
  }
  const payload = recordOf(pair.result.payload);
  const text = resultTextOf(payload?.result)?.trim() ?? '';
  const path = savedScreenshotPath(text);
  const failed = payload?.isError === true;
  return {
    ...base,
    path: failed ? null : path,
    note: path !== null && !failed ? null : text === '' ? null : text,
    failed,
  };
}
