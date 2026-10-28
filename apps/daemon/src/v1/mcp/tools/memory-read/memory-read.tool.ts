import { HOST_MEMORY_READ_TOOL } from '../../../agents/chat.types';
import type { McpToolResult, MemoryCallScope } from '../../mcp.types';
import { memoryFence, MemoryMcpTool } from '../memory-mcp-tool';
import { memoryReadInstructions } from './memory-read.instructions';
import { memoryReadResultText, readMemoryReadArgs } from './memory-read.reader';
import { memoryReadSchema } from './memory-read.schema';

/** `memory_read` — whole shared memory entries by handle. */
export class MemoryReadTool extends MemoryMcpTool {
  readonly name = HOST_MEMORY_READ_TOOL;

  protected instructions(): string {
    return memoryReadInstructions();
  }

  protected inputSchema(): Record<string, unknown> {
    return memoryReadSchema();
  }

  protected async answer(
    args: Record<string, unknown>,
    { projectId }: MemoryCallScope,
  ): Promise<McpToolResult> {
    const read = readMemoryReadArgs(args);
    if (!read.ok) {
      return this.invalidArgs(read.error);
    }
    const { entries, missing } = await this.memory.read(
      read.query.ids,
      projectId,
    );
    return this.masked(memoryReadResultText(entries, missing, memoryFence()));
  }
}
