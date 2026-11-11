import { HOST_BROWSER_NAVIGATE_TOOL } from '../../../agents/chat.types';
import type { BrowserOp } from '../../../browser/browser.types';
import type { ToolArgs } from '../../mcp.types';
import { BrowserTool } from '../browser-shared/browser-tool';
import { browserNavigateInstructions } from './browser-navigate.instructions';
import { readBrowserNavigate } from './browser-navigate.reader';
import { browserNavigateSchema } from './browser-navigate.schema';

/** `browser_navigate` */
export class BrowserNavigateTool extends BrowserTool {
  readonly name = HOST_BROWSER_NAVIGATE_TOOL;

  protected instructions(): string {
    return browserNavigateInstructions();
  }

  protected inputSchema(): Record<string, unknown> {
    return browserNavigateSchema();
  }

  protected readOp(args: Record<string, unknown>): ToolArgs<BrowserOp> {
    return readBrowserNavigate(args);
  }
}
