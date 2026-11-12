import { z } from 'zod';

import type { BrowserOp } from '../../../browser/browser.types';
import type { ToolArgs } from '../../mcp.types';
import {
  browserTabColorField,
  browserTabField,
  browserTabNameField,
  readBrowserOp,
} from '../browser-shared/browser-args';

export const BrowserLabelTabArgsSchema = z.object({
  tab: browserTabField,
  name: browserTabNameField.optional(),
  color: browserTabColorField.optional(),
});

/** `browser_label_tab`'s arguments as the operation main runs. */
export function readBrowserLabelTab(
  args: Record<string, unknown>,
): ToolArgs<BrowserOp> {
  if (args.name == null && args.color == null) {
    return { ok: false, error: 'Give a name, a color or both' };
  }
  return readBrowserOp(
    BrowserLabelTabArgsSchema,
    args,
    ({ tab, name, color }) => ({
      kind: 'label',
      tab,
      ...(name === undefined ? {} : { name }),
      ...(color === undefined ? {} : { color }),
    }),
  );
}
