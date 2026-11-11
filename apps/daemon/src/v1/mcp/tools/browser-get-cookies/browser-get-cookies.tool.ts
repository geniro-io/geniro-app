import { HOST_BROWSER_GET_COOKIES_TOOL } from '../../../agents/chat.types';
import type { BrowserOp } from '../../../browser/browser.types';
import type { ToolArgs } from '../../mcp.types';
import { BrowserTool } from '../browser-shared/browser-tool';
import { browserGetCookiesInstructions } from './browser-get-cookies.instructions';
import { readBrowserGetCookies } from './browser-get-cookies.reader';
import { browserGetCookiesSchema } from './browser-get-cookies.schema';

/** `browser_get_cookies` */
export class BrowserGetCookiesTool extends BrowserTool {
  readonly name = HOST_BROWSER_GET_COOKIES_TOOL;

  protected override readonly readsPage = true;

  protected instructions(): string {
    return browserGetCookiesInstructions();
  }

  protected inputSchema(): Record<string, unknown> {
    return browserGetCookiesSchema();
  }

  protected readOp(args: Record<string, unknown>): ToolArgs<BrowserOp> {
    return readBrowserGetCookies(args);
  }
}
