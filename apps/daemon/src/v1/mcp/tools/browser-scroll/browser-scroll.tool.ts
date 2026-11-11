import { HOST_BROWSER_SCROLL_TOOL } from '../../../agents/chat.types';
import type { BrowserOp } from '../../../browser/browser.types';
import type { ToolArgs } from '../../mcp.types';
import { BrowserTool } from '../browser-shared/browser-tool';
import { browserScrollInstructions } from './browser-scroll.instructions';
import { readBrowserScroll } from './browser-scroll.reader';
import { browserScrollSchema } from './browser-scroll.schema';

/** `browser_scroll` */
export class BrowserScrollTool extends BrowserTool {
  readonly name = HOST_BROWSER_SCROLL_TOOL;

  protected instructions(): string {
    return browserScrollInstructions();
  }

  protected inputSchema(): Record<string, unknown> {
    return browserScrollSchema();
  }

  protected readOp(args: Record<string, unknown>): ToolArgs<BrowserOp> {
    return readBrowserScroll(args);
  }
}
