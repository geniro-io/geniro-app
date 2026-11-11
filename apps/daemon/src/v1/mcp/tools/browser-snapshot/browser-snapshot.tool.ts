import { HOST_BROWSER_SNAPSHOT_TOOL } from '../../../agents/chat.types';
import type { BrowserOp } from '../../../browser/browser.types';
import type { ToolArgs } from '../../mcp.types';
import { BrowserTool } from '../browser-shared/browser-tool';
import { browserSnapshotInstructions } from './browser-snapshot.instructions';
import { readBrowserSnapshot } from './browser-snapshot.reader';
import { browserSnapshotSchema } from './browser-snapshot.schema';

/** `browser_snapshot` */
export class BrowserSnapshotTool extends BrowserTool {
  readonly name = HOST_BROWSER_SNAPSHOT_TOOL;

  protected override readonly readsPage = true;

  protected instructions(): string {
    return browserSnapshotInstructions();
  }

  protected inputSchema(): Record<string, unknown> {
    return browserSnapshotSchema();
  }

  protected readOp(args: Record<string, unknown>): ToolArgs<BrowserOp> {
    return readBrowserSnapshot(args);
  }
}
