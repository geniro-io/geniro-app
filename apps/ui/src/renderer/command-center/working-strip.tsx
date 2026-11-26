import { useLayoutEffect, useRef, useState } from 'react';

import { CONTROL_HOVER } from '../chats/working-card-parts';
import { CARD_BUTTON_CLASS } from '../components/card-hover';
import { ThreadFace } from '../components/thread-face';
import { ThreadHead, type ThreadIdentity } from '../components/thread-head';
import type { ThreadAttention } from '../components/thread-labels';
import { Popover } from '../components/ui/popover';
import { cn } from '../components/ui/utils';
import { useElementSize } from '../components/use-element-size';
import { attentionFrameVariants } from './thread-card';

export interface StripThread {
  runId: string;
  identity: ThreadIdentity;
  attention: ThreadAttention;
  statusText: string;
}

const FACE_CLASS = cn(
  'relative flex shrink-0 cursor-pointer items-center rounded-full border p-0.5 outline-none focus-visible:ring-2 focus-visible:ring-ring',
  CONTROL_HOVER,
);
const MORE_CLASS =
  'flex h-6 shrink-0 cursor-pointer items-center rounded-pill bg-muted px-2 text-xs font-medium text-muted-foreground tabular-nums outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring';

interface StripMetrics {
  /** Where each face ends, measured from the strip's left edge as the faces are drawn. */
  ends: number[];
  /** The room a "+N" takes after the last face shown, its gap included. */
  moreRoom: number;
}

/** How many faces stand in `room` pixels: all of them when they fit, else as many as fit beside a "+N", and at least one. */
export function fitFaces(
  ends: readonly number[],
  room: number,
  moreRoom: number,
): number {
  const last = ends.at(-1);
  if (last === undefined || last <= room) {
    return ends.length;
  }
  let count = 0;
  while (count < ends.length && ends[count]! + moreRoom <= room) {
    count += 1;
  }
  return Math.max(1, count);
}

function metricsOf(row: HTMLElement): StripMetrics {
  const items = [...row.children].filter(
    (child): child is HTMLElement => child instanceof HTMLElement,
  );
  const more = items.pop();
  const ends = items.map((item) => item.offsetLeft + item.offsetWidth);
  const last = ends.at(-1) ?? 0;
  return {
    ends,
    moreRoom:
      more === undefined ? 0 : more.offsetLeft + more.offsetWidth - last,
  };
}

function sameMetrics(a: StripMetrics, b: StripMetrics): boolean {
  return (
    a.moreRoom === b.moreRoom &&
    a.ends.length === b.ends.length &&
    a.ends.every((end, index) => end === b.ends[index])
  );
}

function titleOf(thread: StripThread): string {
  return [thread.identity.title, thread.identity.project, thread.statusText]
    .filter((part): part is string => part !== null && part !== '')
    .join(' · ');
}

export function WorkingStrip({
  threads,
  onOpenThread,
}: {
  threads: readonly StripThread[];
  onOpenThread: (runId: string) => void;
}): React.JSX.Element | null {
  const [measure, room] = useElementSize<HTMLDivElement>();
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLButtonElement | null>(null);
  const rowRef = useRef<HTMLDivElement | null>(null);
  const [metrics, setMetrics] = useState<StripMetrics | null>(null);
  useLayoutEffect(() => {
    const row = rowRef.current;
    if (row === null) {
      return;
    }
    const next = metricsOf(row);
    setMetrics((current) =>
      current !== null && sameMetrics(current, next) ? current : next,
    );
  });
  if (threads.length === 0) {
    return null;
  }
  const fitting =
    room.width === 0 ||
    metrics === null ||
    metrics.ends.length !== threads.length
      ? threads.length
      : fitFaces(metrics.ends, room.width, metrics.moreRoom);
  const shown = threads.slice(0, fitting);
  const hidden = threads.slice(fitting);
  const moreTitle = `${hidden.length} more working ${hidden.length === 1 ? 'thread' : 'threads'}`;
  return (
    <div
      ref={measure}
      data-slot="working-strip"
      role="group"
      aria-label="Threads working"
      className="relative flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
      <div
        ref={rowRef}
        aria-hidden="true"
        inert
        data-slot="working-strip-measure"
        className="pointer-events-none invisible absolute top-0 left-0 flex w-max items-center gap-1">
        {threads.map((thread) => (
          <span key={thread.runId} className={FACE_CLASS}>
            <span className="flex">
              <ThreadFace
                look={thread.identity.face}
                slot="working-strip-measure-face"
                size="sm"
              />
            </span>
          </span>
        ))}
        <span className={MORE_CLASS}>+{threads.length}</span>
      </div>
      {shown.map((thread) => (
        <button
          key={thread.runId}
          type="button"
          data-slot="working-strip-thread"
          data-run={thread.runId}
          title={titleOf(thread)}
          aria-label={`Open ${thread.identity.title}`}
          data-attention={thread.attention}
          onClick={() => onOpenThread(thread.runId)}
          className={cn(
            FACE_CLASS,
            attentionFrameVariants({ attention: thread.attention }),
          )}>
          <span className="pointer-events-none flex">
            <ThreadFace
              look={thread.identity.face}
              slot="working-strip-face"
              size="sm"
            />
          </span>
        </button>
      ))}
      {hidden.length === 0 ? null : (
        <>
          <button
            ref={moreRef}
            type="button"
            data-slot="working-strip-more"
            title={moreTitle}
            aria-label={moreTitle}
            aria-expanded={moreOpen}
            onClick={() => setMoreOpen((open) => !open)}
            className={MORE_CLASS}>
            +{hidden.length}
          </button>
          <Popover
            open={moreOpen}
            onClose={() => setMoreOpen(false)}
            triggerRef={moreRef}
            anchor="viewport"
            side="bottom"
            align="end"
            label="Working threads not shown"
            className="w-72 p-1.5">
            {hidden.map((thread) => (
              <button
                key={thread.runId}
                type="button"
                data-slot="working-strip-row"
                data-run={thread.runId}
                aria-label={`Open ${thread.identity.title}`}
                onClick={() => {
                  setMoreOpen(false);
                  onOpenThread(thread.runId);
                }}
                className={cn(
                  'block w-full cursor-pointer rounded-lg px-2 py-1.5 text-left',
                  CARD_BUTTON_CLASS,
                )}>
                <ThreadHead
                  identity={thread.identity}
                  slot="working-strip-row"
                  ringClassName="ring-popover"
                />
              </button>
            ))}
          </Popover>
        </>
      )}
    </div>
  );
}
