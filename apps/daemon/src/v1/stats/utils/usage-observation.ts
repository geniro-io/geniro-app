import { asRecord, asString } from '../../agents/utils/json-util';

/** A slash command at the start of a user message; a pasted path does not match. */
const COMMAND = /^\/([A-Za-z][\w.:-]{0,63})(?=\s|$)/;

/** A skill name as the counters store it. */
const SKILL_NAME = /^[\w.:-]{1,64}$/;

/** claude's own tool that runs a skill by name. */
const SKILL_TOOL = 'Skill';

/** The command that compacts a conversation, counted as compaction instead. */
const COMPACT_COMMAND = 'compact';

/**
 * Characters of a tool result's text: a string's length, or the summed text
 * of its text blocks; null when the result carries no text to size.
 */
export function resultCharsOf(result: unknown): number | null {
  if (typeof result === 'string') {
    return result.length;
  }
  const blocks = Array.isArray(result)
    ? result
    : Array.isArray(asRecord(result)?.content)
      ? (asRecord(result)?.content as unknown[])
      : null;
  if (blocks === null) {
    return null;
  }
  let chars = 0;
  let sized = false;
  for (const block of blocks) {
    const text = asString(asRecord(block)?.text);
    if (text !== null) {
      chars += text.length;
      sized = true;
    }
  }
  return sized ? chars : null;
}

/** The slash command a user message starts with, without its slash; never its arguments. */
export function commandOf(text: string): string | null {
  const name = COMMAND.exec(text.trimStart())?.[1] ?? null;
  return name === null || name === COMPACT_COMMAND ? null : name;
}

/** The skill a claude `Skill` call runs; its arguments are never read. */
export function skillOf(name: string, input: unknown): string | null {
  if (name !== SKILL_TOOL) {
    return null;
  }
  const skill = asString(asRecord(input)?.skill);
  return skill !== null && SKILL_NAME.test(skill) ? skill : null;
}

/** Whether a row records a compaction: the CLI's summary notice or geniro's own row. */
export function isCompactionRow(payload: unknown): boolean {
  const marker = asRecord(payload)?.compaction;
  return marker !== undefined && marker !== null && marker !== false;
}
