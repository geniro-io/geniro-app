import { HOST_MEMORY_SAVE_TOOL } from '../../../agents/chat.types';
import type { McpToolResult, MemoryCallScope } from '../../mcp.types';
import { memoryFence, MemoryMcpTool } from '../memory-mcp-tool';
import { memorySaveInstructions } from './memory-save.instructions';
import { memorySaveResultText, readMemorySaveArgs } from './memory-save.reader';
import { memorySaveSchema } from './memory-save.schema';

/** `memory_save` — create or update a shared memory entry. */
export class MemorySaveTool extends MemoryMcpTool {
  readonly name = HOST_MEMORY_SAVE_TOOL;

  protected instructions(): string {
    return memorySaveInstructions();
  }

  protected inputSchema(): Record<string, unknown> {
    return memorySaveSchema();
  }

  protected async answer(
    args: Record<string, unknown>,
    { projectId, actor }: MemoryCallScope,
  ): Promise<McpToolResult> {
    const read = readMemorySaveArgs(args);
    if (!read.ok) {
      return this.invalidArgs(read.error);
    }
    const outcome = await this.memory.save(actor, read.query, projectId);
    const { text, isError } = memorySaveResultText(outcome, memoryFence());
    return this.masked(text, isError);
  }
}
