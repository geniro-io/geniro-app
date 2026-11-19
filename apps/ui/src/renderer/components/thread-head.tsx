import { ThreadFace, type ThreadFaceLook } from './thread-face';
import {
  PullRequestLabel,
  ThreadLabelsRow,
  type ThreadLabelsView,
  type ThreadPullRequest,
} from './thread-labels';
import { Button } from './ui/button';
import { cn } from './ui/utils';

/** Who a thread is, as the command center's graph shows it. */
export interface ThreadIdentity extends ThreadLabelsView {
  title: string;
  face: ThreadFaceLook;
  pullRequest: ThreadPullRequest | null;
}

/** A thread known by its title alone: a plain face and no labels. */
export function bareThreadIdentity(title: string): ThreadIdentity {
  return {
    title,
    face: { kind: 'unknown' },
    pullRequest: null,
    status: null,
    agentLabel: null,
    isTeam: false,
    boardCard: null,
    project: null,
    projectColor: null,
  };
}

function hasLabels(identity: ThreadIdentity): boolean {
  return (
    identity.status !== null ||
    identity.agentLabel !== null ||
    identity.boardCard !== null ||
    identity.project !== null
  );
}

/**
 * A thread's head: its face, its title — a press away from the thread where
 * the view can open one — its pull request, and the labels its node on the
 * graph wears. Each part's slot is `slot` followed by what it is.
 */
export function ThreadHead({
  identity,
  slot,
  onOpen,
  aside,
  ringClassName,
}: {
  identity: ThreadIdentity;
  slot: string;
  onOpen?: () => void;
  /** Drawn at the end of the title line. */
  aside?: React.ReactNode;
  ringClassName?: string;
}): React.JSX.Element {
  const titleClass =
    'min-w-0 truncate text-left text-[13px] leading-5 font-semibold text-foreground';
  return (
    <div
      data-slot={`${slot}-head`}
      className="flex min-w-0 items-center gap-2.5">
      <ThreadFace
        look={identity.face}
        slot={`${slot}-face`}
        ringClassName={ringClassName}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex min-w-0 items-center gap-1.5">
          {onOpen === undefined ? (
            <span
              data-slot={`${slot}-title`}
              title={identity.title}
              className={titleClass}>
              {identity.title}
            </span>
          ) : (
            <button
              type="button"
              data-slot={`${slot}-title`}
              title={`Open ${identity.title}`}
              onClick={onOpen}
              className={cn(
                titleClass,
                'cursor-pointer rounded-sm decoration-muted-foreground/60 underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring',
              )}>
              {identity.title}
            </button>
          )}
          {identity.pullRequest === null ? null : (
            <PullRequestLabel
              pullRequest={identity.pullRequest}
              slot={`${slot}-pull-request`}
            />
          )}
          {aside === undefined ? null : (
            <span className="ml-auto flex shrink-0 items-center gap-1.5">
              {aside}
            </span>
          )}
        </div>
        {hasLabels(identity) ? (
          <ThreadLabelsRow view={identity} slot={slot} />
        ) : null}
      </div>
    </div>
  );
}

/** The quiet icon buttons at the end of a thread head. */
export function ThreadHeadIcon({
  slot,
  label,
  title,
  icon,
  onClick,
}: {
  slot: string;
  label: string;
  title: string;
  icon: React.ReactNode;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      data-slot={slot}
      className="size-6 shrink-0 text-muted-foreground hover:text-foreground [&_svg]:size-3.5"
      aria-label={label}
      title={title}
      onClick={onClick}>
      {icon}
    </Button>
  );
}

/** A quiet worded action on a thread: a borderless ghost button, its icon before the word. */
export function ThreadActionButton({
  slot,
  label,
  title,
  icon,
  children,
  onClick,
}: {
  slot: string;
  label: string;
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
  onClick: (anchor: HTMLButtonElement) => void;
}): React.JSX.Element {
  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      data-slot={slot}
      aria-label={label}
      title={title}
      className="h-6 shrink-0 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground [&_svg]:size-3.5"
      onClick={(event) => onClick(event.currentTarget)}>
      {icon}
      {children}
    </Button>
  );
}
