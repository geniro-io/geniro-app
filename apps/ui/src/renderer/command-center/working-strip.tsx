import { useRef, useState } from 'react';

import { CONTROL_HOVER } from '../chats/working-card-parts';
import { ThreadFace, type ThreadFaceLook } from '../components/thread-face';
import { ThreadHead, type ThreadIdentity } from '../components/thread-head';
import { Popover } from '../components/ui/popover';
import { cn } from '../components/ui/utils';
import { useElementSize } from '../components/use-element-size';

export interface StripThread {
  runId: string;
  identity: ThreadIdentity;
  statusText: string;
}

const FACE_PX = 24;
const STACK_FACE_PX = 20;
const STACK_OVERLAP_PX = 6;
const STACK_MAX = 3;
const GAP_PX = 4;
const MORE_PX = 32;

/** The width a face takes in the strip: a 24px face, or a team's stack of 20px faces as AvatarStack lays it out. */
export function faceWidthOf(look: ThreadFaceLook): number {
  if (look.kind !== 'team') {
    return FACE_PX;
  }
  const shown = Math.min(look.people.length, STACK_MAX);
  const count = Math.max(1, shown + (look.total > shown ? 1 : 0));
  return STACK_FACE_PX + (count - 1) * (STACK_FACE_PX - STACK_OVERLAP_PX);
}

/** How many faces stand in `room` pixels: all of them when they fit, else as many as fit beside a "+N" of `overflowWidth`, and at least one. */
export function fitFaces(
  widths: readonly number[],
  room: number,
  gap: number,
  overflowWidth: number,
): number {
  const total = widths.reduce(
    (sum, width, index) => sum + width + (index > 0 ? gap : 0),
    0,
  );
  if (total <= room) {
    return widths.length;
  }
  let used = 0;
  let count = 0;
  for (const width of widths) {
    const next = used + (count > 0 ? gap : 0) + width;
    if (next + gap + overflowWidth > room) {
      break;
    }
    used = next;
    count += 1;
  }
  return Math.max(1, count);
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
  if (threads.length === 0) {
    return null;
  }
  const fitting =
    room.width === 0
      ? threads.length
      : fitFaces(
          threads.map((thread) => faceWidthOf(thread.identity.face)),
          room.width,
          GAP_PX,
          MORE_PX,
        );
  const shown = threads.slice(0, fitting);
  const hidden = threads.slice(fitting);
  const moreTitle = `${hidden.length} more working ${hidden.length === 1 ? 'thread' : 'threads'}`;
  return (
    <div
      ref={measure}
      data-slot="working-strip"
      role="group"
      aria-label="Threads working"
      className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
      {shown.map((thread) => (
        <button
          key={thread.runId}
          type="button"
          data-slot="working-strip-thread"
          data-run={thread.runId}
          title={titleOf(thread)}
          aria-label={`Open ${thread.identity.title}`}
          onClick={() => onOpenThread(thread.runId)}
          className={cn(
            'relative flex shrink-0 cursor-pointer items-center rounded-full p-0.5 outline-none focus-visible:ring-2 focus-visible:ring-ring',
            CONTROL_HOVER,
          )}>
          <span className="pointer-events-none flex">
            <ThreadFace
              look={thread.identity.face}
              slot="working-strip-face"
              size="sm"
            />
          </span>
          <span
            aria-hidden="true"
            data-slot="working-strip-dot"
            className="absolute top-0 right-0 size-2 animate-pulse rounded-full bg-primary ring-2 ring-card motion-reduce:animate-none"
          />
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
            className="flex h-6 shrink-0 cursor-pointer items-center rounded-pill bg-muted px-2 text-xs font-medium text-muted-foreground tabular-nums outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
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
              <div key={thread.runId} className="rounded-lg px-2 py-1.5">
                <ThreadHead
                  identity={thread.identity}
                  slot="working-strip-row"
                  ringClassName="ring-popover"
                  onOpen={() => {
                    setMoreOpen(false);
                    onOpenThread(thread.runId);
                  }}
                />
              </div>
            ))}
          </Popover>
        </>
      )}
    </div>
  );
}
