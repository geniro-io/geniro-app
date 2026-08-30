import {
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  type LucideIcon,
} from 'lucide-react';

import type {
  PullRequestInfo,
  PullRequestRefResult,
} from '../../shared/contracts';
import { PanelLinkRow } from '../components/panel-link-row';
import { Badge } from '../components/ui/badge';
import { cn } from '../components/ui/utils';
import { SHELF_SEGMENT_CLASS } from './shelf-chip';

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
    return { word: 'merged', icon: GitMerge, className: 'text-success' };
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
  return { word: 'open', icon: GitPullRequest, className: 'text-warning' };
}

/**
 * The state as a glyph, and the ONLY place a row states it: green merged,
 * yellow open, grey draft, red closed. It carries its word for a reader who
 * cannot see the colour, since colour and shape are the whole visible signal —
 * every list here draws one row per pull request, so the state repeated as text
 * beside every number was a column of words that said what the icon already
 * said.
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
 * The state is the ICON's — its colour and its shape — never a word beside the
 * number. Within the settled group a merged pull request and an abandoned one
 * are the same row shape, and green-versus-red separates them at a glance where
 * a trailing `· merged` had to be read. The word survives in the row's tooltip
 * and in the icon's own screen-reader text.
 */
export function PullRequestRow({
  pullRequest,
}: {
  pullRequest: PullRequestInfo;
}): React.JSX.Element {
  return (
    <PanelLinkRow
      href={pullRequest.url}
      title={pullRequest.title}
      tooltip={`#${pullRequest.number} ${pullRequest.title} · ${lookOf(pullRequest).word}`}
      icon={<PullRequestStateIcon pullRequest={pullRequest} />}
      meta={`#${pullRequest.number}`}
    />
  );
}

/**
 * THIS thread's pull request as a LABEL — a state glyph and the number, and
 * nothing else.
 *
 * It was a full line on the sidebar row: the glyph, the number and the TITLE,
 * spending the row's whole width on text the row already spends two lines on
 * (the chat's own name, and the last message). REPORTED as "make chip with
 * current pr in threads list smaller - just icon and pr number. And make it as
 * label", and the title is the part that had to go — the number is what
 * identifies a pull request, and the state is what a glance is asking about.
 *
 * A `Badge` rather than a bordered chip, because the sidebar row is not a place
 * for controls: it is one activatable element, and everything drawn inside it is
 * a description of the thread. A chip's affordance would promise a press this
 * cannot honour — an anchor nested inside an activatable row is invalid markup
 * that also steals the row's own click, which is why nothing here is a link. The
 * whole sentence stays on `title`, so the title is one hover away rather than
 * gone.
 */
export function PullRequestBadge({
  pullRequest,
  className,
}: {
  pullRequest: PullRequestInfo;
  className?: string;
}): React.JSX.Element {
  const look = lookOf(pullRequest);
  return (
    <Badge
      data-slot="current-pull-request"
      variant="muted"
      title={`#${pullRequest.number} ${pullRequest.title} · ${look.word}`}
      className={cn('gap-1 px-1.5 py-0 font-normal', className)}>
      <PullRequestStateIcon pullRequest={pullRequest} />
      <span className="tabular-nums">#{pullRequest.number}</span>
    </Badge>
  );
}

/**
 * How a pull request the THREAD opened is named when the thread spans several
 * repositories.
 *
 * `#87` is unambiguous inside one repository and meaningless across six — the
 * measured case here opened `#3` in two different ones. So the repository is
 * part of the name exactly when there is more than one on screen, and never
 * otherwise: prefixing every row in a single-repository thread is noise that
 * pushes the title out.
 */
export function pullRequestLabel(
  ref: { repo: string; number: number },
  showRepo: boolean,
): string {
  return showRepo ? `${ref.repo}#${ref.number}` : `#${ref.number}`;
}

/**
 * One pull request THIS THREAD opened, in the right-hand panel.
 *
 * Draws from whatever is known: a resolved row gets the title and the state its
 * sibling {@link PullRequestRow} draws, and an unresolved one still gets a row.
 * That fallback is the point rather than a nicety — the thread demonstrably
 * opened this pull request, so "GitHub could not be asked" must not make it
 * disappear, which is exactly what a list built only from `gh` answers would do
 * on a logged-out machine.
 */
export function ThreadPullRequestRow({
  result,
  showRepo,
}: {
  result: PullRequestRefResult;
  showRepo: boolean;
}): React.JSX.Element {
  const { ref, pullRequest } = result;
  const name = pullRequestLabel(ref, showRepo);
  if (pullRequest === null) {
    return (
      <PanelLinkRow
        href={ref.url}
        title={name}
        tooltip={`${ref.owner}/${ref.repo}#${ref.number}`}
        icon={
          <GitPullRequest
            aria-hidden="true"
            className="size-3.5 shrink-0 text-muted-foreground"
          />
        }
      />
    );
  }
  return (
    <PanelLinkRow
      href={pullRequest.url}
      title={pullRequest.title}
      tooltip={`${ref.owner}/${ref.repo}#${ref.number} ${pullRequest.title} · ${lookOf(pullRequest).word}`}
      icon={<PullRequestStateIcon pullRequest={pullRequest} />}
      meta={name}
    />
  );
}

/**
 * The same pull request as a CHIP for the shelf above the composer.
 *
 * A shelf chip is deliberately not a panel row: it sits in a wrapping row
 * beside whatever else the shelf carries, so it takes a bounded width and gives
 * the rest to its neighbours — the title truncates, the number never does,
 * since the number is what identifies it.
 */
export function ThreadPullRequestChip({
  result,
  showRepo,
  widthClassName = 'max-w-56',
}: {
  result: PullRequestRefResult;
  showRepo: boolean;
  /**
   * How wide this chip may get — the SHELF's decision, since it depends on how
   * many are drawn beside it (`PULL_REQUEST_CHIP_WIDTH`). Defaulted to the lone
   * chip's width so a caller that draws exactly one need not say so.
   */
  widthClassName?: string;
}): React.JSX.Element {
  const { ref, pullRequest } = result;
  const name = pullRequestLabel(ref, showRepo);
  const label =
    pullRequest === null
      ? `${ref.owner}/${ref.repo}#${ref.number}`
      : `${name} ${pullRequest.title} · ${lookOf(pullRequest).word}`;
  return (
    <a
      data-slot="pull-request-chip"
      href={ref.url}
      target="_blank"
      rel="noreferrer"
      title={label}
      className={cn(SHELF_SEGMENT_CLASS, widthClassName)}>
      {pullRequest === null ? (
        <GitPullRequest
          aria-hidden="true"
          className="size-3.5 shrink-0 text-muted-foreground"
        />
      ) : (
        <PullRequestStateIcon pullRequest={pullRequest} />
      )}
      <span className="shrink-0 font-medium">{name}</span>
      {pullRequest === null ? null : (
        <span className="min-w-0 truncate text-muted-foreground">
          {pullRequest.title}
        </span>
      )}
    </a>
  );
}
