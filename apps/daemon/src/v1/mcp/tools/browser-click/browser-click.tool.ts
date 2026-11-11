import { HOST_BROWSER_CLICK_TOOL } from '../../../agents/chat.types';
import type { BrowserOp } from '../../../browser/browser.types';
import type { ToolArgs } from '../../mcp.types';
import { BrowserTool } from '../browser-shared/browser-tool';
import { browserClickInstructions } from './browser-click.instructions';
import { readBrowserClick } from './browser-click.reader';
import { browserClickSchema } from './browser-click.schema';

/** `browser_click` */
export class BrowserClickTool extends BrowserTool {
  readonly name = HOST_BROWSER_CLICK_TOOL;

  protected instructions(): string {
    return browserClickInstructions();
  }

  protected inputSchema(): Record<string, unknown> {
    return browserClickSchema();
  }

  protected readOp(args: Record<string, unknown>): ToolArgs<BrowserOp> {
    return readBrowserClick(args);
  }
}
