import { HOST_BROWSER_CLEAR_COOKIES_TOOL } from '../../../agents/chat.types';
import type { BrowserOp } from '../../../browser/browser.types';
import type { ToolArgs } from '../../mcp.types';
import { BrowserTool } from '../browser-shared/browser-tool';
import { browserClearCookiesInstructions } from './browser-clear-cookies.instructions';
import { readBrowserClearCookies } from './browser-clear-cookies.reader';
import { browserClearCookiesSchema } from './browser-clear-cookies.schema';

/** `browser_clear_cookies` */
export class BrowserClearCookiesTool extends BrowserTool {
  readonly name = HOST_BROWSER_CLEAR_COOKIES_TOOL;

  protected instructions(): string {
    return browserClearCookiesInstructions();
  }

  protected inputSchema(): Record<string, unknown> {
    return browserClearCookiesSchema();
  }

  protected readOp(args: Record<string, unknown>): ToolArgs<BrowserOp> {
    return readBrowserClearCookies(args);
  }
}
