import { HOST_BROWSER_CLOSE_TOOL } from '../../../agents/chat.types';
import type { BrowserOp } from '../../../browser/browser.types';
import type { ToolArgs } from '../../mcp.types';
import { BrowserTool } from '../browser-shared/browser-tool';
import { browserCloseInstructions } from './browser-close.instructions';
import { readBrowserClose } from './browser-close.reader';
import { browserCloseSchema } from './browser-close.schema';

/** `browser_close` */
export class BrowserCloseTool extends BrowserTool {
  readonly name = HOST_BROWSER_CLOSE_TOOL;

  protected instructions(): string {
    return browserCloseInstructions();
  }

  protected inputSchema(): Record<string, unknown> {
    return browserCloseSchema();
  }

  protected readOp(args: Record<string, unknown>): ToolArgs<BrowserOp> {
    return readBrowserClose(args);
  }
}
