import { HOST_BROWSER_SET_COOKIES_TOOL } from '../../../agents/chat.types';
import type { BrowserOp } from '../../../browser/browser.types';
import type { ToolArgs } from '../../mcp.types';
import { BrowserTool } from '../browser-shared/browser-tool';
import { browserSetCookiesInstructions } from './browser-set-cookies.instructions';
import { readBrowserSetCookies } from './browser-set-cookies.reader';
import { browserSetCookiesSchema } from './browser-set-cookies.schema';

/** `browser_set_cookies` */
export class BrowserSetCookiesTool extends BrowserTool {
  readonly name = HOST_BROWSER_SET_COOKIES_TOOL;

  protected instructions(): string {
    return browserSetCookiesInstructions();
  }

  protected inputSchema(): Record<string, unknown> {
    return browserSetCookiesSchema();
  }

  protected readOp(args: Record<string, unknown>): ToolArgs<BrowserOp> {
    return readBrowserSetCookies(args);
  }
}
