import { HOST_MEMORY_FORGET_TOOL } from '../../../agents/chat.types';
import type { McpToolResult, MemoryCallScope } from '../../mcp.types';
import { MemoryMcpTool } from '../memory-mcp-tool';
import { memoryForgetInstructions } from './memory-forget.instructions';
import {
  memoryForgetResultText,
  readMemoryForgetArgs,
} from './memory-forget.reader';
import { memoryForgetSchema } from './memory-forget.schema';

/** `memory_forget` — retire a shared memory entry (the user can restore it). */
export class MemoryForgetTool extends MemoryMcpTool {
  readonly name = HOST_MEMORY_FORGET_TOOL;

  protected instructions(): string {
    return memoryForgetInstructions();
  }

  protected inputSchema(): Record<string, unknown> {
    return memoryForgetSchema();
  }

  protected async answer(
    args: Record<string, unknown>,
    { projectId, actor }: MemoryCallScope,
  ): Promise<McpToolResult> {
    const read = readMemoryForgetArgs(args);
    if (!read.ok) {
      return this.invalidArgs(read.error);
    }
    const outcome = await this.memory.forget(
      actor,
      read.query.id,
      read.query.reason,
      projectId,
    );
    const { text, isError } = memoryForgetResultText(outcome);
    return this.masked(text, isError);
  }
}
