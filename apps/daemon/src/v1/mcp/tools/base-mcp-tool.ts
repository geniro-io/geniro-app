import type {
  McpCallContext,
  McpListContext,
  McpTool,
  McpToolListing,
  McpToolResult,
} from '../mcp.types';

/**
 * The shared shape of every tool geniro writes for its own MCP endpoint.
 *
 * One tool is one directory under `tools/`, laid out the same way every time:
 *
 * - `<tool>.tool.ts` — the class: when the tool is offered and what a call does
 * - `<tool>.instructions.ts` — the description a model reads, which is the
 *   tool's routing logic and by far its largest part
 * - `<tool>.schema.ts` — the argument schema, its field descriptions included
 * - `<tool>.reader.ts` — reading the model's arguments and wording the result
 *
 * A subclass names itself and fills four hooks; listing and dispatch are
 * concrete here, so no tool can list itself in a shape another tool does not.
 */
export abstract class BaseMcpTool implements McpTool {
  /** The tool's name on the wire. */
  abstract readonly name: string;

  /**
   * `_meta` for the listing row, when the tool needs one. Only the call tools
   * do (`ALWAYS_LOADED_TOOL_META`).
   */
  protected readonly meta: Record<string, unknown> | null = null;

  /** Whether this asker is offered the tool right now. */
  protected abstract isOffered(context: McpListContext): boolean;

  /** The description a model reads — `<tool>.instructions.ts`. */
  protected abstract instructions(context: McpListContext): string;

  /** The argument schema — `<tool>.schema.ts`. */
  protected abstract inputSchema(
    context: McpListContext,
  ): Record<string, unknown>;

  /** Answer one call of this tool. Never throws. */
  protected abstract run(
    args: Record<string, unknown>,
    context: McpCallContext,
  ): Promise<McpToolResult>;

  handles(name: string): boolean {
    return name === this.name;
  }

  list(context: McpListContext): McpToolListing[] {
    if (!this.isOffered(context)) {
      return [];
    }
    return [
      {
        name: this.name,
        description: this.instructions(context),
        inputSchema: this.inputSchema(context),
        ...(this.meta === null ? {} : { _meta: this.meta }),
      },
    ];
  }

  call(
    _name: string,
    args: Record<string, unknown>,
    context: McpCallContext,
  ): Promise<McpToolResult> {
    return this.run(args, context);
  }

  /** A plain text answer. */
  protected text(text: string, isError = false): McpToolResult {
    return { content: [{ type: 'text', text }], isError };
  }

  /** A malformed call, answered in-protocol rather than thrown. */
  protected invalidArgs(reason: string): McpToolResult {
    return this.text(`INVALID_ARGS: ${reason}`, true);
  }
}
