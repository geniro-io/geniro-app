import { HOST_BROWSER_OPEN_TOOL } from '../../../agents/chat.types';
import type { BrowserOp } from '../../../browser/browser.types';
import type { ToolArgs } from '../../mcp.types';
import { BrowserTool } from '../browser-shared/browser-tool';
import { browserOpenInstructions } from './browser-open.instructions';
import { readBrowserOpen } from './browser-open.reader';
import { browserOpenSchema } from './browser-open.schema';

/** `browser_open` */
export class BrowserOpenTool extends BrowserTool {
  readonly name = HOST_BROWSER_OPEN_TOOL;

  protected override readonly readsPage = true;

  protected instructions(): string {
    return browserOpenInstructions();
  }

  protected inputSchema(): Record<string, unknown> {
    return browserOpenSchema();
  }

  protected readOp(args: Record<string, unknown>): ToolArgs<BrowserOp> {
    return readBrowserOpen(args);
  }
}
