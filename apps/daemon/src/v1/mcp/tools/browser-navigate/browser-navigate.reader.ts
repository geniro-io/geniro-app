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
  url: browserUrlField.describe('The http(s) address to load in that tab.'),
});

/** `browser_navigate`'s arguments as the operation main runs. */
export function readBrowserNavigate(
  args: Record<string, unknown>,
): ToolArgs<BrowserOp> {
  return readBrowserOp(BrowserNavigateArgsSchema, args, ({ tab, url }) => ({
    kind: 'navigate',
    tab,
    url,
  }));
}
