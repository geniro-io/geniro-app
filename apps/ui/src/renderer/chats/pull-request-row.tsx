import {
  ExternalLink,
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
}: {
  result: PullRequestRefResult;
  showRepo: boolean;
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
      className="flex min-w-0 max-w-56 items-center gap-1.5 rounded-lg border border-border bg-card px-2 py-1 text-xs shadow-panel-sm hover:bg-sidebar-accent">
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
