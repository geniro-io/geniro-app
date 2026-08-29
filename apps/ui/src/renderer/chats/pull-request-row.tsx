import {
  ExternalLink,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  type LucideIcon,
} from 'lucide-react';

import type { PullRequestInfo } from '../../shared/contracts';
import { PanelLinkRow } from '../components/panel-link-row';
import { cn } from '../components/ui/utils';

/**
 * How one state is drawn — the single mapping, so the panel's list, the sidebar
 * row and the composer band cannot end up calling the same pull request three
 * different things.
 *
 * A DRAFT is a state of its own here rather than a flag on `open`: that is how
 * it reads on screen and how GitHub itself labels it, and a draft listed as
 * plain `open` would say a pull request is asking for review when it is not.
 */
interface PullRequestLook {
  word: string;
  icon: LucideIcon;
  className: string;
}

function lookOf(pullRequest: PullRequestInfo): PullRequestLook {
  if (pullRequest.state === 'merged') {
    return { word: 'merged', icon: GitMerge, className: 'text-primary' };
  }
  if (pullRequest.state === 'closed') {
    return {
      word: 'closed',
      icon: GitPullRequestClosed,
      className: 'text-destructive',
    };
  }
  if (pullRequest.isDraft) {
    return {
      word: 'draft',
      icon: GitPullRequestDraft,
      className: 'text-muted-foreground',
    };
  }
  return { word: 'open', icon: GitPullRequest, className: 'text-success' };
}

/**
 * The state as a glyph, with its word carried for a reader who cannot see the
 * colour — the colour and the shape are the whole signal otherwise.
 */
export function PullRequestStateIcon({
  pullRequest,
}: {
  pullRequest: PullRequestInfo;
}): React.JSX.Element {
  const look = lookOf(pullRequest);
  const Icon = look.icon;
  return (
    <>
      <Icon
        aria-hidden="true"
        className={cn('size-3.5 shrink-0', look.className)}
      />
      <span className="sr-only">{look.word}</span>
    </>
  );
}

/**
 * One pull request in the right-hand panel's list.
 *
 * The state is spelled out beside the number rather than left to the glyph
 * alone: within the settled group a merged pull request and an abandoned one
 * are the same row shape, and which one it is is the reason to look.
 */
export function PullRequestRow({
  pullRequest,
}: {
  pullRequest: PullRequestInfo;
}): React.JSX.Element {
  const look = lookOf(pullRequest);
  return (
    <PanelLinkRow
      href={pullRequest.url}
      title={pullRequest.title}
      tooltip={`#${pullRequest.number} ${pullRequest.title}`}
      icon={<PullRequestStateIcon pullRequest={pullRequest} />}
      meta={`#${pullRequest.number} · ${look.word}`}
    />
  );
}

/**
 * THIS thread's pull request, on one line — the sidebar row and the band above
 * the composer.
 *
 * `interactive` is what separates the two, and it is not a style choice: the
 * sidebar row is itself an activatable element, and an anchor nested inside one
 * is invalid markup that also steals the row's own click.
 */
export function CurrentPullRequestLine({
  pullRequest,
  interactive = false,
  className,
}: {
  pullRequest: PullRequestInfo;
  interactive?: boolean;
  className?: string;
}): React.JSX.Element {
  const look = lookOf(pullRequest);
  const body = (
    <>
      <PullRequestStateIcon pullRequest={pullRequest} />
      <span className="shrink-0 font-medium">#{pullRequest.number}</span>
      <span className="min-w-0 truncate">{pullRequest.title}</span>
      {interactive ? (
        <ExternalLink className="size-3 shrink-0 text-muted-foreground" />
      ) : null}
    </>
  );
  const shared = cn(
    'flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground',
    className,
  );
  const label = `#${pullRequest.number} ${pullRequest.title} · ${look.word}`;
  return interactive ? (
    <a
      data-slot="current-pull-request"
      href={pullRequest.url}
      target="_blank"
      rel="noreferrer"
      title={label}
      className={cn(shared, 'hover:text-foreground')}>
      {body}
    </a>
  ) : (
    <span data-slot="current-pull-request" title={label} className={shared}>
      {body}
    </span>
  );
}
