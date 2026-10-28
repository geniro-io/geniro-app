import { HOST_MEMORY_SEARCH_TOOL } from '../../../agents/chat.types';
import type { McpToolResult, MemoryCallScope } from '../../mcp.types';
import { MemoryMcpTool } from '../memory-mcp-tool';
import { memorySearchInstructions } from './memory-search.instructions';
import {
  memorySearchResultText,
  readMemorySearchArgs,
} from './memory-search.reader';
import { memorySearchSchema } from './memory-search.schema';

/** `memory_search` — find shared memory entries by words. */
export class MemorySearchTool extends MemoryMcpTool {
  readonly name = HOST_MEMORY_SEARCH_TOOL;

  protected instructions(): string {
    return memorySearchInstructions();
  }

  protected inputSchema(): Record<string, unknown> {
    return memorySearchSchema();
  }

  protected async answer(
    args: Record<string, unknown>,
    { projectId }: MemoryCallScope,
  ): Promise<McpToolResult> {
    const read = readMemorySearchArgs(args);
    if (!read.ok) {
      return this.invalidArgs(read.error);
    }
    const hits = await this.memory.search(
      read.query.query,
      projectId,
      read.query.limit,
    );
    return this.masked(memorySearchResultText(read.query.query, hits));
  }
}
