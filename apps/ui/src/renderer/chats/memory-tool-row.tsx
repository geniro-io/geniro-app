import { BookmarkPlus, BookOpen, Eraser, Search } from 'lucide-react';
import { createContext, Fragment, useContext } from 'react';

import { Button } from '../components/ui/button';
import { Spinner } from '../components/ui/spinner';
import { cn } from '../components/ui/utils';
import type { BlockStatus } from './block-shell';
import { type GeniroMemoryTool, geniroMemoryToolOf } from './geniro-tool';
import type { ToolPair } from './transcript-groups';
import { payloadString } from './transcript-payload';

/**
 * Open Settings → Memory at one entry, by its handle (`m12`); null where
 * nothing can take the reader there, which draws the handle as plain text.
 */
export const MemoryOpenContext = createContext<
  ((handle: string) => void) | null
>(null);

type SaveOutcome = 'saved' | 'updated' | 'duplicate' | 'stale' | 'refused';

/** What a memory tool call said and got back, read off its untyped payloads. */
export type MemoryToolEntry =
  | { tool: 'memory_search'; query: string; count: number | null }
  | { tool: 'memory_read'; handles: string[]; missing: string[] }
  | {
      tool: 'memory_save';
      title: string;
      handle: string | null;
      outcome: SaveOutcome | null;
      pending: boolean;
      note: string | null;
    }
  | {
      tool: 'memory_forget';
      handle: string;
      reason: string | null;
      failure: string | null;
    };

const HANDLE_PATTERN = /^m?(\d{1,9})$/i;

function normalizedHandle(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const match = HANDLE_PATTERN.exec(value.trim());
  return match === null ? null : `m${Number(match[1])}`;
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** The text of a result that arrives bare, as MCP content blocks, or wrapped. */
function resultTextOf(result: unknown): string | null {
  if (typeof result === 'string') {
    return result;
  }
  if (Array.isArray(result)) {
    const texts = result.flatMap((block) => {
      const text = recordOf(block)?.text;
      return typeof text === 'string' ? [text] : [];
    });
    return texts.length > 0 ? texts.join('\n') : null;
  }
  const record = recordOf(result);
  return record === null ? null : resultTextOf(record.content);
}

function firstLine(text: string): string {
  return text.split('\n', 1)[0]?.trim() ?? '';
}

/** The reason after a refusal's `CODE: ` prefix, or the line itself. */
function refusalReason(text: string): string {
  const line = firstLine(text);
  const match = /^[A-Z][A-Z_]+: (.+)$/.exec(line);
  return match?.[1] ?? line;
}

function searchEntry(
  args: Record<string, unknown>,
  text: string | null,
  failed: boolean,
): MemoryToolEntry | null {
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  if (query === '') {
    return null;
  }
  let count: number | null = null;
  if (text !== null && !failed) {
    count = text.startsWith('No memory matches')
      ? 0
      : (text.match(/^- m\d+ \(rev /gm)?.length ?? null);
  }
  return { tool: 'memory_search', query, count };
}

function readEntry(
  args: Record<string, unknown>,
  text: string | null,
): MemoryToolEntry | null {
  if (!Array.isArray(args.ids)) {
    return null;
  }
  const handles = args.ids
    .map(normalizedHandle)
    .filter((handle): handle is string => handle !== null);
  if (handles.length === 0) {
    return null;
  }
  const notFound = /^Not found: (.+?) — /m.exec(text ?? '')?.[1] ?? '';
  const named = new Set(notFound.split(',').map(normalizedHandle));
  return {
    tool: 'memory_read',
    handles,
    missing: handles.filter((handle) => named.has(handle)),
  };
}

function saveEntry(
  args: Record<string, unknown>,
  text: string | null,
  failed: boolean,
): MemoryToolEntry | null {
  const title = typeof args.title === 'string' ? args.title.trim() : '';
  if (title === '') {
    return null;
  }
  const entry = {
    tool: 'memory_save' as const,
    title,
    handle: normalizedHandle(args.id),
    outcome: null as SaveOutcome | null,
    pending: false,
    note: null as string | null,
  };
  if (text === null) {
    return entry;
  }
  const done = /^(Saved|Updated) (m\d+) \(/.exec(text);
  if (done !== null && !failed) {
    return {
      ...entry,
      handle: done[2] ?? entry.handle,
      outcome: done[1] === 'Saved' ? 'saved' : 'updated',
      pending: text.includes("waits for the user's review"),
    };
  }
  if (text.includes('Not saved: this looks like')) {
    return { ...entry, outcome: 'duplicate' };
  }
  if (text.includes('changed since you read it')) {
    return { ...entry, outcome: 'stale' };
  }
  if (failed) {
    return { ...entry, outcome: 'refused', note: refusalReason(text) };
  }
  return entry;
}

function forgetEntry(
  args: Record<string, unknown>,
  text: string | null,
  failed: boolean,
): MemoryToolEntry | null {
  const handle = normalizedHandle(args.id);
  if (handle === null) {
    return null;
  }
  const reason =
    typeof args.reason === 'string' && args.reason.trim() !== ''
      ? args.reason.trim()
      : null;
  return {
    tool: 'memory_forget',
    handle,
    reason,
    failure: failed && text !== null ? refusalReason(text) : null,
  };
}

function entryOf(
  tool: GeniroMemoryTool,
  args: Record<string, unknown>,
  text: string | null,
  failed: boolean,
): MemoryToolEntry | null {
  switch (tool) {
    case 'memory_search':
      return searchEntry(args, text, failed);
    case 'memory_read':
      return readEntry(args, text);
    case 'memory_save':
      return saveEntry(args, text, failed);
    case 'memory_forget':
      return forgetEntry(args, text, failed);
  }
}

/**
 * The memory row a tool pair draws, or null when the pair is not one of the
 * shared-memory tools of this run's own server or its arguments cannot be read
 * — the caller then draws the ordinary tool row.
 *
 * TWIN PARSER: the result texts of `memorySearchResultText`,
 * `memoryReadResultText`, `memorySaveResultText`, `memoryForgetResultText`
 * (each in `apps/daemon/src/v1/mcp/tools/memory-<tool>/`) and
 * `memoryEntryLine` (`apps/daemon/src/v1/mcp/tools/memory-mcp-tool.ts`).
 */
export function memoryToolEntryOf(pair: ToolPair): MemoryToolEntry | null {
  const name = payloadString(pair.call.payload, 'name') ?? '';
  const tool = geniroMemoryToolOf(name, pair.call.runId);
  if (tool === null) {
    return null;
  }
  const args = recordOf(recordOf(pair.call.payload)?.input);
  if (args === null) {
    return null;
  }
  const resultPayload = recordOf(pair.result?.payload);
  return entryOf(
    tool,
    args,
    resultTextOf(resultPayload?.result),
    resultPayload?.isError === true,
  );
}

const TOOL_ICON = {
  memory_search: Search,
  memory_read: BookOpen,
  memory_save: BookmarkPlus,
  memory_forget: Eraser,
} as const;

function Handle({ handle }: { handle: string }): React.JSX.Element {
  const openMemory = useContext(MemoryOpenContext);
  if (openMemory === null) {
    return <span className="font-mono">{handle}</span>;
  }
  return (
    <Button
      type="button"
      variant="link"
      onClick={() => openMemory(handle)}
      aria-label={`Open ${handle} in Settings → Memory`}
      className="h-auto p-0 font-mono text-xs">
      {handle}
    </Button>
  );
}

function Dot(): React.JSX.Element {
  return (
    <>
      {' '}
      <span aria-hidden="true" className="text-muted-foreground/60">
        ·
      </span>{' '}
    </>
  );
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function SaveOutcomeTag({
  entry,
}: {
  entry: Extract<MemoryToolEntry, { tool: 'memory_save' }>;
}): React.JSX.Element | null {
  const text =
    entry.outcome === 'duplicate'
      ? 'near-duplicate of an existing entry'
      : entry.outcome === 'stale'
        ? 'changed since it was read'
        : entry.outcome === 'refused'
          ? (entry.note ?? 'refused')
          : entry.pending
            ? 'waits for review'
            : null;
  if (text === null) {
    return null;
  }
  const refused = entry.outcome !== 'saved' && entry.outcome !== 'updated';
  return (
    <>
      <Dot />
      <span className={cn(refused ? 'text-destructive' : 'text-warning')}>
        {text}
      </span>
    </>
  );
}

function saveLabel(
  entry: Extract<MemoryToolEntry, { tool: 'memory_save' }>,
  running: boolean,
): string {
  if (running) {
    return entry.handle === null ? 'Saving memory' : 'Updating memory';
  }
  switch (entry.outcome) {
    case 'updated':
      return 'Updated memory';
    case 'saved':
      return 'Saved memory';
    case null:
      return entry.handle === null ? 'Saved memory' : 'Updated memory';
    default:
      return 'Memory not saved';
  }
}

function labelOf(entry: MemoryToolEntry, running: boolean): string {
  switch (entry.tool) {
    case 'memory_search':
      return running ? 'Searching memory' : 'Searched memory';
    case 'memory_read':
      return running ? 'Reading memory' : 'Read memory';
    case 'memory_save':
      return saveLabel(entry, running);
    case 'memory_forget':
      return running ? 'Forgetting memory' : 'Forgot memory';
  }
}

function Detail({ entry }: { entry: MemoryToolEntry }): React.JSX.Element {
  switch (entry.tool) {
    case 'memory_search':
      return (
        <>
          {entry.count === null ? null : (
            <>
              <Dot />
              <span>{plural(entry.count, 'result')}</span>
            </>
          )}{' '}
          <span className="min-w-0 truncate text-muted-foreground/70">
            “{entry.query}”
          </span>
        </>
      );
    case 'memory_read':
      return (
        <>
          <Dot />
          <span>
            {entry.handles.map((handle, index) => (
              <Fragment key={handle}>
                {index === 0 ? null : ', '}
                {entry.missing.includes(handle) ? (
                  <span className="font-mono line-through">{handle}</span>
                ) : (
                  <Handle handle={handle} />
                )}
              </Fragment>
            ))}
          </span>
          {entry.missing.length === 0 ? null : (
            <>
              {' '}
              <span className="text-muted-foreground/70">
                {entry.missing.join(', ')} not found
              </span>
            </>
          )}
        </>
      );
    case 'memory_save':
      return (
        <>
          <Dot />
          <span className="min-w-0 truncate text-foreground">
            {entry.title}
          </span>
          {entry.handle === null ||
          entry.outcome === 'duplicate' ||
          entry.outcome === 'refused' ? null : (
            <>
              {' '}
              <Handle handle={entry.handle} />
            </>
          )}
          <SaveOutcomeTag entry={entry} />
        </>
      );
    case 'memory_forget':
      return (
        <>
          <Dot />
          <Handle handle={entry.handle} />
          {entry.failure === null ? null : (
            <>
              <Dot />
              <span className="text-destructive">{entry.failure}</span>
            </>
          )}
          {entry.reason === null || entry.failure !== null ? null : (
            <>
              {' '}
              <span className="min-w-0 truncate text-muted-foreground/70">
                {entry.reason}
              </span>
            </>
          )}
        </>
      );
  }
}

/**
 * One shared-memory tool call as a single compact line inside the transcript's
 * tool run: what was searched, read, saved or forgotten, and the handle of an
 * entry as a link to it in Settings → Memory where {@link MemoryOpenContext}
 * can take the reader there.
 */
export function MemoryToolRow({
  entry,
  status,
}: {
  entry: MemoryToolEntry;
  status: BlockStatus;
}): React.JSX.Element {
  const running = status === 'running';
  const Icon = TOOL_ICON[entry.tool];
  const failed =
    status === 'error' &&
    entry.tool !== 'memory_save' &&
    !(entry.tool === 'memory_forget' && entry.failure !== null);
  return (
    <div
      data-role="memory-tool"
      data-memory-tool={entry.tool}
      className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 py-0.5 text-xs text-muted-foreground">
      <Icon aria-hidden="true" className="size-3.5 shrink-0" />
      <span
        className={cn('font-medium', failed ? 'text-destructive' : undefined)}>
        {labelOf(entry, running)}
      </span>{' '}
      <Detail entry={entry} />
      {running ? <Spinner /> : null}
      {status === 'stopped' ? (
        <>
          {' '}
          <span className="text-muted-foreground/70">no result</span>
        </>
      ) : null}
    </div>
  );
}
