import { HOST_BROWSER_SELECT_TOOL } from '../../../agents/chat.types';
import type { BrowserOp } from '../../../browser/browser.types';
import type { ToolArgs } from '../../mcp.types';
import { BrowserTool } from '../browser-shared/browser-tool';
import { browserSelectInstructions } from './browser-select.instructions';
import { readBrowserSelect } from './browser-select.reader';
import { browserSelectSchema } from './browser-select.schema';

/** `browser_select` */
export class BrowserSelectTool extends BrowserTool {
  readonly name = HOST_BROWSER_SELECT_TOOL;

  protected instructions(): string {
    return browserSelectInstructions();
  }

  protected inputSchema(): Record<string, unknown> {
    return browserSelectSchema();
  }

  protected readOp(args: Record<string, unknown>): ToolArgs<BrowserOp> {
    return readBrowserSelect(args);
  }
}
