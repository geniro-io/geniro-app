import { ChevronRight, Loader2 } from 'lucide-react';
import { memo, useState } from 'react';

import { CodeBlock } from '../components/ui/code-block';
import { cn } from '../components/ui/utils';
import { DiffView } from './diff-view';
import { toolInputBody, toolResultBody } from './tool-render';
import {
  toolCallSummary,
  type ToolGroupEntry,
  toolGroupSummary,
  type ToolPair,
  toolResultText,
} from './transcript-groups';
import { payloadString } from './transcript-item';

/** One expandable tool invocation inside a group. */
function ToolRow({ pair }: { pair: ToolPair }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const name = payloadString(pair.call.payload, 'name') ?? 'tool';
  const summary = toolCallSummary(pair.call);
  const input = (pair.call.payload as { input?: unknown } | null)?.input;
  const body = toolInputBody(name, input);
  const result = pair.result
    ? ((pair.result.payload as { result?: unknown } | null)?.result ?? null)
    : null;
  // The CALL's input decides how its result reads (a file's contents have no
  // hint of their own language; command output must not be painted as shell).
  const resultBody = toolResultBody(input, toolResultText(result));
  return (
    <div className="flex flex-col">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-xs hover:bg-accent/50">
        <ChevronRight
          aria-hidden="true"
          className={cn(
            'size-3 shrink-0 transition-transform',
            open && 'rotate-90',
          )}
        />
        <span className="shrink-0 font-medium">{name}</span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          {summary}
        </span>
        {pair.result === null ? (
          <span className="shrink-0 text-muted-foreground">…</span>
        ) : null}
      </button>
      {open ? (
        <div className="flex flex-col gap-1.5 py-1 pl-6 pr-1.5">
          {body.kind === 'diff' ? (
            <>
              {body.caption ? (
                <div className="font-mono text-xs text-muted-foreground">
                  {body.caption}
                </div>
              ) : null}
              <DiffView oldText={body.oldText} newText={body.newText} />
            </>
          ) : (
            <CodeBlock
              code={body.code}
              language={body.language}
              caption={body.caption}
            />
          )}
          {pair.result !== null ? (
            <div className="flex flex-col gap-0.5">
              <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                result
              </span>
              <CodeBlock
                code={resultBody.code}
                language={resultBody.language}
              />
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * A collapsed run of tool calls — geniro web's WorkingBlock: a bare
 * summary header ("Used N tools · edited M files…", chevron, a spinner
 * while a call is still in flight), with the per-invocation rows behind
 * it; each row expands again to the full input (a red/green diff for
 * Edit/Write) and the tool's result.
 */
export const ToolGroup = memo(function ToolGroup({
  group,
}: {
  group: ToolGroupEntry;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const running = group.pairs.some((pair) => pair.result === null);
  return (
    <div
      data-role="tool-group"
      className="flex w-full flex-col gap-1.5 text-sm">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 text-left text-xs font-semibold text-muted-foreground transition-colors hover:text-foreground">
        <ChevronRight
          aria-hidden="true"
          className={cn(
            'size-3.5 shrink-0 transition-transform',
            open && 'rotate-90',
          )}
        />
        <span className="truncate">{toolGroupSummary(group.pairs)}</span>
        {running ? (
          <Loader2
            aria-hidden="true"
            className="size-3 shrink-0 animate-spin text-primary"
          />
        ) : null}
      </button>
      {open ? (
        <div className="flex flex-col gap-1.5 text-muted-foreground">
          {group.pairs.map((pair) => (
            <ToolRow key={pair.call.id} pair={pair} />
          ))}
        </div>
      ) : null}
    </div>
  );
});
