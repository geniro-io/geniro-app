import { HOST_PATCH_TOOL } from '../../../agents/chat.types';
import type { PatchBroker } from '../../../agents/services/patch.broker';
import type {
  McpCallContext,
  McpListContext,
  McpToolResult,
} from '../../mcp.types';
import { BaseMcpTool } from '../base-mcp-tool';
import { proposePatchInstructions } from './propose-patch.instructions';
import { hostPatchResultText, readHostPatch } from './propose-patch.reader';
import { proposePatchSchema } from './propose-patch.schema';

/** `propose_patch` — a change to one file, written only if the user accepts. */
export class ProposePatchTool extends BaseMcpTool {
  readonly name = HOST_PATCH_TOOL;

  constructor(private readonly patches: PatchBroker) {
    super();
  }

  protected isOffered({ runId, nodeId }: McpListContext): boolean {
    return this.patches.canPropose(runId, nodeId);
  }

  protected instructions(): string {
    return proposePatchInstructions();
  }

  protected inputSchema(): Record<string, unknown> {
    return proposePatchSchema();
  }

  protected async run(
    args: Record<string, unknown>,
    context: McpCallContext,
  ): Promise<McpToolResult> {
    const { runId, nodeId } = context;
    const read = readHostPatch(args);
    // The reader answers with a SENTENCE rather than a bare null, because
    // every refusal here names something the agent can fix and retry.
    if (!read.ok) {
      return this.invalidArgs(read.reason);
    }
    // This one BLOCKS until the user answers the card — the only tool on
    // this endpoint besides `ask_user_question` that does.
    const outcome = await context.whileCancellable((signal) =>
      this.patches.propose(runId, nodeId, read.patch, signal),
    );
    // A rejection is not a tool failure: the user exercised the gate this
    // tool exists to offer them, and flagging it as an error is how a
    // model comes to retry a change that was just turned down.
    return this.text(hostPatchResultText(outcome));
  }
}
