import {
  type ReadAnalyzedThreadArgs,
  ReadAnalyzedThreadArgsSchema,
} from '../../../agents/chat.types';
import { redactSecrets } from '../../../diagnostics/utils/redact';
import type { ToolArgs } from '../../mcp.types';
import { historyResultText } from '../history-mcp-tool';
import { readToolArgs } from '../tool-args';

/** A `read_analyzed_thread` call's query, or why it cannot be read. */
export function readAnalyzedThreadArgs(
  args: Record<string, unknown>,
): ToolArgs<ReadAnalyzedThreadArgs> {
  return readToolArgs(ReadAnalyzedThreadArgsSchema.strict(), args);
}

/**
 * One page as the agent reads it: the data-not-instructions line first — a
 * page quoted from another thread can arrive many turns after the description
 * was read — and every registered secret masked over the whole text.
 */
export function analyzedThreadResultText(answer: unknown): string {
  return redactSecrets(historyResultText(answer));
}
