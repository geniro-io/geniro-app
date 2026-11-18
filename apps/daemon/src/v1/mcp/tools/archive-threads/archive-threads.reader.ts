import {
  type ArchiveThreadsAnswer,
  type ArchiveThreadsInput,
  ArchiveThreadsSchema,
} from '../../../agents/chat.types';
import type { ToolArgs } from '../../mcp.types';
import { readToolArgs } from '../tool-args';

/** An `archive_threads` call's arguments, or why they cannot be read. */
export function readArchiveThreadsArgs(
  args: Record<string, unknown>,
): ToolArgs<ArchiveThreadsInput> {
  return readToolArgs(ArchiveThreadsSchema.strict(), args);
}

/** The answer as the manager reads it: the JSON, then what to do next. */
export function archiveThreadsResultText(answer: ArchiveThreadsAnswer): string {
  return `${JSON.stringify(answer)}\n${nextStepOf(answer)}`;
}

function nextStepOf(answer: ArchiveThreadsAnswer): string {
  if (answer.unresolved.length > 0) {
    return 'Nothing was archived. Ask the user which threads they meant — the candidates are listed — then call again.';
  }
  const refused = answer.archived.filter((row) => row.outcome === 'refused');
  if (refused.length === 0) {
    return 'Every thread above is archived. Tell the user which ones.';
  }
  return `Not archived: ${refused.map((row) => `${row.to} (${row.code ?? 'refused'})`).join(', ')}. Tell the user; every other thread above is archived.`;
}
