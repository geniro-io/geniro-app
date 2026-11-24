import { HOST_UI_TOOL } from '../../../agents/chat.types';
import type { SurfaceBroker } from '../../../agents/services/surface.broker';
import type {
  McpCallContext,
  McpListContext,
  McpToolResult,
} from '../../mcp.types';
import { BaseMcpTool } from '../base-mcp-tool';
import { showUiInstructions } from './show-ui.instructions';
import { hostUiResultText, readHostUi } from './show-ui.reader';
import { showUiSchema } from './show-ui.schema';

export class ShowUiTool extends BaseMcpTool {
  readonly name = HOST_UI_TOOL;

  constructor(private readonly surfaces: SurfaceBroker) {
    super();
  }

  protected isOffered({ runId, memberId }: McpListContext): boolean {
    return this.surfaces.canDraw(runId, memberId);
  }

  protected instructions(): string {
    return showUiInstructions();
  }

  protected inputSchema(): Record<string, unknown> {
    return showUiSchema();
  }

  protected async run(
    args: Record<string, unknown>,
    context: McpCallContext,
  ): Promise<McpToolResult> {
    const { runId, memberId, caller } = context;
    const call = readHostUi(args);
    if (call === null) {
      return this.invalidArgs(
        "'messages' must be a non-empty array of A2UI v1.0 messages for one surface.",
      );
    }
    const outcome = await context.whileCancellable((cancel) =>
      this.surfaces.draw(
        runId,
        memberId,
        call,
        caller,
        context.gone === undefined
          ? cancel
          : AbortSignal.any([cancel, context.gone]),
      ),
    );
    if (outcome.status === 'invalid') {
      return this.invalidArgs(outcome.error);
    }
    return this.text(hostUiResultText(outcome));
  }
}
