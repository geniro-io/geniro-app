import {
  type ThreadListQuery,
  ThreadListQuerySchema,
} from '../../../agents/chat.types';
import type { ToolArgs } from '../../mcp.types';
import { readToolArgs } from '../tool-args';

/** A `list_threads` call's query, or why it cannot be read. */
export function readListThreadsArgs(
  args: Record<string, unknown>,
): ToolArgs<ThreadListQuery> {
  return readToolArgs(ThreadListQuerySchema.strict(), args);
}
