import { HOST_BROWSER_TYPE_TOOL } from '../../../agents/chat.types';
import type { BrowserOp } from '../../../browser/browser.types';
import type { ToolArgs } from '../../mcp.types';
import { BrowserTool } from '../browser-shared/browser-tool';
import { browserTypeInstructions } from './browser-type.instructions';
import { readBrowserType } from './browser-type.reader';
import { browserTypeSchema } from './browser-type.schema';

/** `browser_type` */
export class BrowserTypeTool extends BrowserTool {
  readonly name = HOST_BROWSER_TYPE_TOOL;

  protected instructions(): string {
    return browserTypeInstructions();
  }

  protected inputSchema(): Record<string, unknown> {
    return browserTypeSchema();
  }

  protected readOp(args: Record<string, unknown>): ToolArgs<BrowserOp> {
    return readBrowserType(args);
  }
}
