import {
  type BrowserRunOutcome,
  HOST_BROWSER_SCREENSHOT_TOOL,
} from '../../../agents/chat.types';
import type { AttachmentStoreService } from '../../../agents/services/attachment-store.service';
import type { BrowserBroker } from '../../../agents/services/browser.broker';
import type { BrowserOp } from '../../../browser/browser.types';
import type { McpToolResult, ToolArgs } from '../../mcp.types';
import { browserDoneText } from '../browser-shared/browser-outcome';
import { BrowserTool } from '../browser-shared/browser-tool';
import { browserScreenshotInstructions } from './browser-screenshot.instructions';
import { readBrowserScreenshot } from './browser-screenshot.reader';
import { browserScreenshotSchema } from './browser-screenshot.schema';

/** `browser_screenshot` — a tab as a picture, saved; put into the result only when asked to `view` it. */
export class BrowserScreenshotTool extends BrowserTool {
  readonly name = HOST_BROWSER_SCREENSHOT_TOOL;

  constructor(
    broker: BrowserBroker,
    private readonly attachments: AttachmentStoreService,
  ) {
    super(broker);
  }

  protected instructions(): string {
    return browserScreenshotInstructions();
  }

  protected inputSchema(): Record<string, unknown> {
    return browserScreenshotSchema();
  }

  protected readOp(args: Record<string, unknown>): ToolArgs<BrowserOp> {
    return readBrowserScreenshot(args);
  }

  protected override done(
    outcome: Extract<BrowserRunOutcome, { status: 'done' }>,
    runId: string,
  ): McpToolResult {
    if (outcome.png === undefined) {
      return this.text(
        `The browser answered without a picture. Try ${this.name} again.`,
        true,
      );
    }
    let path: string;
    try {
      path = this.attachments.saveDownloaded(
        runId,
        'image/png',
        Buffer.from(outcome.png, 'base64'),
      );
    } catch (error) {
      return this.text(
        `The screenshot could not be saved: ${error instanceof Error ? error.message : String(error)}`,
        true,
      );
    }
    const text = browserDoneText(
      outcome.text === ''
        ? `Saved screenshot: ${path}`
        : `Saved screenshot: ${path}\n${outcome.text}`,
      outcome.tab,
    );
    return outcome.viewPng === undefined
      ? this.text(text)
      : this.withImages(this.text(text), [
          { data: outcome.viewPng, mimeType: 'image/png' },
        ]);
  }
}
