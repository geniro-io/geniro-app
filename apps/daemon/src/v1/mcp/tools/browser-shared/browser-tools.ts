import type { AttachmentStoreService } from '../../../agents/services/attachment-store.service';
import type { BrowserBroker } from '../../../agents/services/browser.broker';
import type { McpTool } from '../../mcp.types';
import { BrowserClearCookiesTool } from '../browser-clear-cookies/browser-clear-cookies.tool';
import { BrowserClickTool } from '../browser-click/browser-click.tool';
import { BrowserCloseTool } from '../browser-close/browser-close.tool';
import { BrowserConsoleTool } from '../browser-console/browser-console.tool';
import { BrowserEvaluateTool } from '../browser-evaluate/browser-evaluate.tool';
import { BrowserGetCookiesTool } from '../browser-get-cookies/browser-get-cookies.tool';
import { BrowserNavigateTool } from '../browser-navigate/browser-navigate.tool';
import { BrowserOpenTool } from '../browser-open/browser-open.tool';
import { BrowserPressTool } from '../browser-press/browser-press.tool';
import { BrowserScreenshotTool } from '../browser-screenshot/browser-screenshot.tool';
import { BrowserScrollTool } from '../browser-scroll/browser-scroll.tool';
import { BrowserSelectTool } from '../browser-select/browser-select.tool';
import { BrowserSetCookiesTool } from '../browser-set-cookies/browser-set-cookies.tool';
import { BrowserSnapshotTool } from '../browser-snapshot/browser-snapshot.tool';
import { BrowserTabsTool } from '../browser-tabs/browser-tabs.tool';
import { BrowserTypeTool } from '../browser-type/browser-type.tool';

/** The in-app browser's tools, in the order `tools/list` names them. */
export function createBrowserTools(
  broker: BrowserBroker,
  attachments: AttachmentStoreService,
): McpTool[] {
  return [
    new BrowserOpenTool(broker),
    new BrowserNavigateTool(broker),
    new BrowserSnapshotTool(broker),
    new BrowserClickTool(broker),
    new BrowserTypeTool(broker),
    new BrowserPressTool(broker),
    new BrowserSelectTool(broker),
    new BrowserScrollTool(broker),
    new BrowserScreenshotTool(broker, attachments),
    new BrowserConsoleTool(broker),
    new BrowserEvaluateTool(broker),
    new BrowserTabsTool(broker),
    new BrowserCloseTool(broker),
    new BrowserSetCookiesTool(broker),
    new BrowserGetCookiesTool(broker),
    new BrowserClearCookiesTool(broker),
  ];
}
