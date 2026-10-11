import { HOST_GALLERY_TOOL } from '../../../agents/chat.types';
import type { GalleryBroker } from '../../../agents/services/gallery.broker';
import type {
  McpCallContext,
  McpListContext,
  McpToolResult,
} from '../../mcp.types';
import { BaseMcpTool } from '../base-mcp-tool';
import { showGalleryInstructions } from './show-gallery.instructions';
import { hostGalleryResultText, readHostGallery } from './show-gallery.reader';
import { showGallerySchema } from './show-gallery.schema';

/** `show_gallery` — several pictures as one steppable set. */
export class ShowGalleryTool extends BaseMcpTool {
  readonly name = HOST_GALLERY_TOOL;

  constructor(private readonly galleries: GalleryBroker) {
    super();
  }

  protected isOffered({ runId, nodeId }: McpListContext): boolean {
    return this.galleries.canDraw(runId, nodeId);
  }

  protected instructions(): string {
    return showGalleryInstructions();
  }

  protected inputSchema(): Record<string, unknown> {
    return showGallerySchema();
  }

  protected async run(
    args: Record<string, unknown>,
    context: McpCallContext,
  ): Promise<McpToolResult> {
    const { runId, nodeId } = context;
    const gallery = readHostGallery(args);
    // Null is the reader saying no entry named a file. Answered as a
    // malformed call on the chart's rule: a gallery of no pictures is only
    // ever a mistake.
    if (gallery === null) {
      return this.invalidArgs(
        "no image to show — 'images' must hold at least one entry with a 'path'.",
      );
    }
    const outcome = await this.galleries.draw(runId, nodeId, gallery);
    // Same reading as its drawing siblings: an unavailable channel is an
    // answer, not a failure — the agent still knows where the files are.
    return this.text(hostGalleryResultText(outcome));
  }
}
