import { HOST_GALLERY_TOOL } from '../../../agents/chat.types';
import type { GalleryBroker } from '../../../agents/services/gallery.broker';
import type { GalleryImageService } from '../../../agents/services/gallery-image.service';
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

  constructor(
    private readonly galleries: GalleryBroker,
    private readonly images: GalleryImageService,
  ) {
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
    const requested = readHostGallery(args);
    // Null is the reader saying no entry named a file. Answered as a
    // malformed call on the chart's rule: a gallery of no pictures is only
    // ever a mistake.
    if (requested === null) {
      return this.invalidArgs(
        "no image to show — 'images' must hold at least one entry with a 'path'.",
      );
    }
    // Asked before anything is downloaded: a call that arrives after its turn
    // ended would otherwise fetch every URL for a card nobody draws.
    if (!this.galleries.canDraw(runId, nodeId)) {
      return this.text(
        hostGalleryResultText({
          status: 'unavailable',
          reason: 'this conversation has no turn to draw it in',
        }),
      );
    }
    let cancelled = false;
    const { gallery, failures } = await context.whileCancellable(
      async (cancel) => {
        // The request going away counts too: a chat's Stop kills the CLI
        // without a cancel, and the next turn's sink would take the card.
        const signal =
          context.gone === undefined
            ? cancel
            : AbortSignal.any([cancel, context.gone]);
        const localized = await this.images.localize(runId, requested, signal);
        cancelled = signal.aborted;
        return localized;
      },
    );
    if (gallery === null) {
      return this.text(
        hostGalleryResultText(
          { status: 'unavailable', reason: 'no image could be downloaded' },
          failures,
        ),
      );
    }
    if (cancelled) {
      this.images.discard(runId, gallery);
      return this.text(
        hostGalleryResultText({
          status: 'unavailable',
          reason: 'the call was cancelled',
        }),
      );
    }
    const outcome = await this.galleries.draw(runId, nodeId, gallery);
    if (outcome.status === 'unavailable') {
      this.images.discard(runId, gallery);
    }
    // Same reading as its drawing siblings: an unavailable channel is an
    // answer, not a failure — the agent still knows where the files are.
    return this.text(hostGalleryResultText(outcome, failures));
  }
}
