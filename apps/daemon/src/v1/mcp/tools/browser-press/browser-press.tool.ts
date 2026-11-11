import { HOST_BROWSER_PRESS_TOOL } from '../../../agents/chat.types';
import type { BrowserOp } from '../../../browser/browser.types';
import type { ToolArgs } from '../../mcp.types';
import { BrowserTool } from '../browser-shared/browser-tool';
import { browserPressInstructions } from './browser-press.instructions';
import { readBrowserPress } from './browser-press.reader';
import { browserPressSchema } from './browser-press.schema';

/** `browser_press` */
export class BrowserPressTool extends BrowserTool {
  readonly name = HOST_BROWSER_PRESS_TOOL;

  protected instructions(): string {
    return browserPressInstructions();
  }

  protected inputSchema(): Record<string, unknown> {
    return browserPressSchema();
  }

  protected readOp(args: Record<string, unknown>): ToolArgs<BrowserOp> {
    return readBrowserPress(args);
  }
}
