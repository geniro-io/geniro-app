import { HOST_BROWSER_CONSOLE_TOOL } from '../../../agents/chat.types';
import type { BrowserOp } from '../../../browser/browser.types';
import type { ToolArgs } from '../../mcp.types';
import { BrowserTool } from '../browser-shared/browser-tool';
import { browserConsoleInstructions } from './browser-console.instructions';
import { readBrowserConsole } from './browser-console.reader';
import { browserConsoleSchema } from './browser-console.schema';

/** `browser_console` */
export class BrowserConsoleTool extends BrowserTool {
  readonly name = HOST_BROWSER_CONSOLE_TOOL;

  protected override readonly readsPage = true;

  protected instructions(): string {
    return browserConsoleInstructions();
  }

  protected inputSchema(): Record<string, unknown> {
    return browserConsoleSchema();
  }

  protected readOp(args: Record<string, unknown>): ToolArgs<BrowserOp> {
    return readBrowserConsole(args);
  }
}
