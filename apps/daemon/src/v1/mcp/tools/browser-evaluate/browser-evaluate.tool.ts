import { HOST_BROWSER_EVALUATE_TOOL } from '../../../agents/chat.types';
import type { BrowserOp } from '../../../browser/browser.types';
import type { ToolArgs } from '../../mcp.types';
import { BrowserTool } from '../browser-shared/browser-tool';
import { browserEvaluateInstructions } from './browser-evaluate.instructions';
import { readBrowserEvaluate } from './browser-evaluate.reader';
import { browserEvaluateSchema } from './browser-evaluate.schema';

/** `browser_evaluate` */
export class BrowserEvaluateTool extends BrowserTool {
  readonly name = HOST_BROWSER_EVALUATE_TOOL;

  protected override readonly readsPage = true;

  protected instructions(): string {
    return browserEvaluateInstructions();
  }

  protected inputSchema(): Record<string, unknown> {
    return browserEvaluateSchema();
  }

  protected readOp(args: Record<string, unknown>): ToolArgs<BrowserOp> {
    return readBrowserEvaluate(args);
  }
}
