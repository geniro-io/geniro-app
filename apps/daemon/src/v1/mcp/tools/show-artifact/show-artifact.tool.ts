import { HOST_ARTIFACT_TOOL } from '../../../agents/chat.types';
import type { ArtifactBroker } from '../../../agents/services/artifact.broker';
import type {
  McpCallContext,
  McpListContext,
  McpToolResult,
} from '../../mcp.types';
import { BaseMcpTool } from '../base-mcp-tool';
import { showArtifactInstructions } from './show-artifact.instructions';
import {
  hostArtifactResultText,
  readHostArtifact,
} from './show-artifact.reader';
import { showArtifactSchema } from './show-artifact.schema';

/** `show_artifact` — publish a page the agent wrote, revisable in place. */
export class ShowArtifactTool extends BaseMcpTool {
  readonly name = HOST_ARTIFACT_TOOL;

  constructor(private readonly artifacts: ArtifactBroker) {
    super();
  }

  protected isOffered({ runId, nodeId }: McpListContext): boolean {
    return this.artifacts.canPublish(runId, nodeId);
  }

  protected instructions(): string {
    return showArtifactInstructions();
  }

  protected inputSchema(): Record<string, unknown> {
    return showArtifactSchema();
  }

  protected async run(
    args: Record<string, unknown>,
    context: McpCallContext,
  ): Promise<McpToolResult> {
    const { runId, nodeId } = context;
    const artifact = readHostArtifact(args);
    // Null is the reader saying there is no page here — no document, or no
    // title to list it under. A malformed call on the chart's rule: an
    // artifact of nothing is only ever a mistake.
    if (artifact === null) {
      return this.invalidArgs(
        "no page to show — 'html' must hold the document and 'title' must name it.",
      );
    }
    const outcome = await this.artifacts.publish(runId, nodeId, artifact);
    // Same reading as its drawing siblings, and it covers `rejected` too:
    // an oversize page is an answer the agent acts on by writing a
    // smaller one, not a call it got wrong.
    return this.text(hostArtifactResultText(outcome));
  }
}
