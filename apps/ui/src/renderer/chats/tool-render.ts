import {
  JSON_LANGUAGE,
  languageForPath,
  SHELL_LANGUAGE,
} from '../components/ui/code-language';
import { editDiffOf } from './diff-view';

/**
 * How one tool's input or result should be rendered.
 *
 * Dispatch is SHAPE-FIRST, name-second. The tool NAME is only a fast path:
 * what actually decides the rendering is the payload's shape, so a CLI that
 * calls its shell tool something else still gets a highlighted command, and an
 * unrecognized tool degrades to highlighted JSON rather than a wall of text.
 *
 * TWIN PARSER (shape half): these payloads are the CLIs' own tool arguments —
 * they never pass through a typed daemon response, so no generated type
 * describes them and every field is read defensively. The daemon's matching
 * knowledge lives in `apps/daemon/src/v1/agents/adapters/claude/` (see
 * `utils/claude-question.utils.ts` for the same pattern on AskUserQuestion).
 */
export type ToolCodeBody = {
  kind: 'code';
  code: string;
  language: string | null;
  caption: string | null;
};

export type ToolBody =
  | ToolCodeBody
  | {
      kind: 'diff';
      oldText: string | null;
      newText: string;
      caption: string | null;
    };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asText(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** Pretty JSON that never throws (a payload can hold a cycle). */
function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/** The file a tool is acting on, under any of the spellings in use. */
export function filePathOf(input: unknown): string | null {
  const record = asRecord(input);
  if (!record) {
    return null;
  }
  return (
    asText(record.file_path) ??
    asText(record.filePath) ??
    asText(record.path) ??
    asText(record.notebook_path)
  );
}

/** The shell command a tool is running, under any of the spellings in use. */
function commandOf(input: unknown): string | null {
  const record = asRecord(input);
  if (!record) {
    return null;
  }
  return asText(record.command) ?? asText(record.cmd) ?? asText(record.script);
}

/**
 * Whether a tool call disclosed any arguments at all.
 *
 * TWIN PARSER: `disclosedInput` in
 * `apps/daemon/src/v1/agents/adapters/acp/acp-driver.ts` makes the same
 * judgement on the daemon side, normalizing an agent-sent empty bag to null
 * before it is persisted. A tool payload never passes through a typed daemon
 * response — every item kind carries a different shape, so the payload is
 * `z.unknown()` on the wire BY DESIGN and no generated type spans the two sides.
 * Both readings must agree: widen one and the other must widen with it.
 *
 * Kept here rather than inlined at each call site because BOTH renderer surfaces
 * that show a call's arguments — the transcript row and the approval card — have
 * to answer it the same way. They did not, briefly: the daemon started sending
 * null and the card rendered the word `null` where it used to render `{}`.
 */
export function disclosesInput(input: unknown): boolean {
  if (input === null || input === undefined) {
    return false;
  }
  const record = asRecord(input);
  return record === null || Object.keys(record).length > 0;
}

/**
 * How to render a tool CALL's input: a diff for an edit, the command for a
 * shell tool, the contents for a write, else the payload as JSON.
 *
 * Null when the call disclosed no arguments at all, so the caller renders NO
 * body rather than a body whose whole content is `{}` or `null`. An ACP agent
 * may name a call and withhold its arguments (measured on cursor-agent for its
 * read/search/edit calls — see `disclosedInput` in the daemon's `acp-driver.ts`),
 * and printing the empty bag stated those as the arguments; the row's header
 * already carries the tool's name, which is the part that is actually known.
 */
export function toolInputBody(
  toolName: string,
  input: unknown,
): ToolBody | null {
  // Reuse the existing edit detection rather than re-deriving it — DiffView is
  // already the shared rendering for Edit/Write on the tool row AND the
  // approval card.
  const diff = editDiffOf(toolName, input);
  if (diff) {
    return {
      kind: 'diff',
      oldText: diff.oldText,
      newText: diff.newText,
      caption: filePathOf(input),
    };
  }
  const command = commandOf(input);
  if (command !== null) {
    const record = asRecord(input);
    return {
      kind: 'code',
      code: command,
      language: SHELL_LANGUAGE,
      caption: record ? asText(record.description) : null,
    };
  }
  const path = filePathOf(input);
  const record = asRecord(input);
  const content = record ? asText(record.content) : null;
  if (path !== null && content !== null) {
    return {
      kind: 'code',
      code: content,
      language: languageForPath(path),
      caption: path,
    };
  }
  // Nothing was disclosed: no diff, no command, no contents, no target, and no
  // remaining payload to show. `prettyJson` would render this as the literal
  // `{}` or `null` — a body that asserts the arguments were empty rather than
  // absent. There is no body.
  if (!disclosesInput(input)) {
    return null;
  }
  // A read/glob/grep-shaped call has nothing but its target — the header line
  // already says the tool name, so show the path as the body's caption and let
  // the rest be the payload.
  return {
    kind: 'code',
    code: prettyJson(input),
    language: JSON_LANGUAGE,
    caption: path,
  };
}

/**
 * How to render a tool RESULT. The CALL'S INPUT decides the language — a
 * file's contents come back as bare text with no hint of what they are, so
 * only the path that was read can say. (Which is why the input is a parameter
 * here at all: the result alone is not enough to render it well.)
 */
export function toolResultBody(input: unknown, result: unknown): ToolCodeBody {
  const text = typeof result === 'string' ? result : prettyJson(result);
  if (commandOf(input) !== null) {
    // Command OUTPUT is not shell source — highlighting it as bash would paint
    // arbitrary words as keywords. Plain, but still in the code surface.
    return { kind: 'code', code: text, language: null, caption: null };
  }
  const path = filePathOf(input);
  if (path !== null && typeof result === 'string') {
    return {
      kind: 'code',
      code: stripLineNumbers(text),
      language: languageForPath(path),
      caption: null,
    };
  }
  return {
    kind: 'code',
    code: text,
    language: typeof result === 'string' ? null : JSON_LANGUAGE,
    caption: null,
  };
}

/**
 * Drop the `cat -n` gutter a file read comes back with (`␣␣␣␣␣1→body`), so the
 * contents highlight as the language they are instead of as numbered noise.
 * Only applied when EVERY non-empty line carries one — a file that happens to
 * start with numbers keeps its text.
 */
export function stripLineNumbers(text: string): string {
  const lines = text.split('\n');
  const gutter = /^\s*\d+\t(.*)$/;
  const stripped: string[] = [];
  for (const line of lines) {
    if (line === '') {
      stripped.push(line);
      continue;
    }
    const match = gutter.exec(line);
    if (!match) {
      return text;
    }
    stripped.push(match[1] ?? '');
  }
  return stripped.join('\n');
}

/**
 * A tool identifier as a reader should see it: `mcp__linear__get_issue` →
 * "Linear: Get issue".
 *
 * Ported from geniro web's `formatToolName` (`components/ui/thread-blocks.tsx`)
 * so a tool row reads the same in both apps. Only the MCP triple-underscore
 * shape is rewritten — every other name is returned verbatim, because a
 * built-in's identifier (`Bash`, `WebFetch`) is the name the user knows it by
 * and "prettifying" it would only make it harder to match against the CLI's own
 * output.
 */
export function formatToolName(toolName: string): string {
  const parsed = /^mcp__(.+?)__(.+)$/.exec(toolName);
  if (!parsed) {
    return toolName;
  }
  const [, server = '', tool = ''] = parsed;
  const capitalize = (text: string): string =>
    text.length > 0 ? `${text.charAt(0).toUpperCase()}${text.slice(1)}` : text;
  return `${capitalize(server)}: ${capitalize(tool.replace(/_/g, ' '))}`;
}
