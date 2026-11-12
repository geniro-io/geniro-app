import { HOST_BROWSER_LABEL_TAB_TOOL } from '../../../agents/chat.types';
import type { BrowserOp } from '../../../browser/browser.types';
import type { ToolArgs } from '../../mcp.types';
import { BrowserTool } from '../browser-shared/browser-tool';
import { browserLabelTabInstructions } from './browser-label-tab.instructions';
import { readBrowserLabelTab } from './browser-label-tab.reader';
import { browserLabelTabSchema } from './browser-label-tab.schema';

/** `browser_label_tab` */
export class BrowserLabelTabTool extends BrowserTool {
  readonly name = HOST_BROWSER_LABEL_TAB_TOOL;

  protected instructions(): string {
    return browserLabelTabInstructions();
  }

  protected inputSchema(): Record<string, unknown> {
    return browserLabelTabSchema();
  }

  protected readOp(args: Record<string, unknown>): ToolArgs<BrowserOp> {
    return readBrowserLabelTab(args);
  }
}
