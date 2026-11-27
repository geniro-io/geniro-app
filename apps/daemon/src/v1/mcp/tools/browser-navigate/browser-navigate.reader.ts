import { z } from 'zod';

import type { BrowserOp } from '../../../browser/browser.types';
import type { ToolArgs } from '../../mcp.types';
import {
  browserTabField,
  browserUrlField,
  readBrowserOp,
} from '../browser-shared/browser-args';

export const BrowserNavigateArgsSchema = z.object({
  tab: browserTabField,
  url: browserUrlField.describe(
    'The http(s) address to load in that tab; the address it already shows reloads it.',
  ),
  force: z
    .boolean()
    .optional()
    .describe(
      'Leave the page even when its beforeunload handler asks to stay (an unsaved-changes guard), discarding what it would keep. Leave it out to let the page keep its unsaved state.',
    ),
});

/** `browser_navigate`'s arguments as the operation main runs. */
export function readBrowserNavigate(
  args: Record<string, unknown>,
): ToolArgs<BrowserOp> {
  return readBrowserOp(
    BrowserNavigateArgsSchema,
    args,
    ({ tab, url, force }) => ({
      kind: 'navigate',
      tab,
      url,
      ...(force === true ? { force } : {}),
    }),
  );
}
