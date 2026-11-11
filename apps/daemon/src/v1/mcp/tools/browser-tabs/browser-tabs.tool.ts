import { HOST_BROWSER_TABS_TOOL } from '../../../agents/chat.types';
import type { BrowserOp } from '../../../browser/browser.types';
import type { ToolArgs } from '../../mcp.types';
import { BrowserTool } from '../browser-shared/browser-tool';
import { browserTabsInstructions } from './browser-tabs.instructions';
import { readBrowserTabs } from './browser-tabs.reader';
import { browserTabsSchema } from './browser-tabs.schema';

/** `browser_tabs` */
export class BrowserTabsTool extends BrowserTool {
  readonly name = HOST_BROWSER_TABS_TOOL;

  protected override readonly readsPage = true;

  protected instructions(): string {
    return browserTabsInstructions();
  }

  protected inputSchema(): Record<string, unknown> {
    return browserTabsSchema();
  }

  protected readOp(args: Record<string, unknown>): ToolArgs<BrowserOp> {
    return readBrowserTabs(args);
  }
}
