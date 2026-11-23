import { cva } from 'class-variance-authority';
import { Bug, Cog, type LucideIcon, Sparkles, TrendingUp } from 'lucide-react';
import type React from 'react';

import {
  CHANGELOG_KIND_HEADING,
  type ChangelogKind,
  type ChangelogRelease,
} from '../../shared/changelog';
import { Badge } from './ui/badge';
import { cn } from './ui/utils';

const KIND_ICON: Record<ChangelogKind, LucideIcon> = {
  new: Sparkles,
  improved: TrendingUp,
  fixed: Bug,
  internal: Cog,
};

const kindVariants = cva(
  'flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide [&>svg]:size-3.5',
  {
    variants: {
      kind: {
        new: 'text-primary',
        improved: 'text-success',
        fixed: 'text-warning',
        internal: 'text-muted-foreground',
      },
    },
  },
);

const markerVariants = cva('mt-2 size-1.5 shrink-0 rounded-full', {
  variants: {
    kind: {
      new: 'bg-primary',
      improved: 'bg-success',
      fixed: 'bg-warning',
      internal: 'bg-muted-foreground',
    },
  },
});

export const ENTRY_LIST_CLASS = 'm-0 flex list-none flex-col gap-1.5 p-0';

const INLINE = /(\*\*[^*]+\*\*|`[^`]+`)/g;

/** An entry's `**bold**` and `` `code` `` spans; everything else is plain text. */
export function ChangelogEntryText({
  text,
}: {
  text: string;
}): React.JSX.Element {
  return (
    <>
      {text.split(INLINE).map((part, index) => {
        if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
          return (
            <strong key={index} className="font-semibold text-foreground">
              {part.slice(2, -2)}
            </strong>
          );
        }
        if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
          return (
            <code
              key={index}
              className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">
              {part.slice(1, -1)}
            </code>
          );
        }
        return part;
      })}
    </>
  );
}

/** `2026-11-23` as the reader's calendar day, e.g. "Nov 23, 2026". */
export function formatReleaseDate(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  if (!year || !month || !day) {
    return date;
  }
  return new Date(year, month - 1, day).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/** A kind's heading over its entries: its icon and name in the kind's colour. */
export function ChangelogKindHeading({
  kind,
}: {
  kind: ChangelogKind;
}): React.JSX.Element {
  const Icon = KIND_ICON[kind];
  return (
    <h4 className={kindVariants({ kind })}>
      <Icon aria-hidden="true" />
      {CHANGELOG_KIND_HEADING[kind]}
    </h4>
  );
}

/** One entry of a kind's list, with an optional trailing note such as its release. */
export function ChangelogEntryLine({
  kind,
  text,
  children,
}: {
  kind: ChangelogKind;
  text: string;
  children?: React.ReactNode;
}): React.JSX.Element {
  return (
    <li className="flex gap-2.5 text-sm leading-relaxed text-foreground/90">
      <span aria-hidden="true" className={markerVariants({ kind })} />
      <span className="min-w-0">
        <ChangelogEntryText text={text} />
        {children}
      </span>
    </li>
  );
}

/** The DOM id a release's card carries, so a version can be jumped to. */
export function releaseAnchorId(version: string | null): string {
  return `release-${version ?? 'unreleased'}`;
}

/**
 * One release of the changelog: its version and date, then each kind of
 * change with its entries. Used by the "What's new" dialog and Settings.
 */
export function ChangelogReleaseCard({
  release,
  current = false,
  className,
}: {
  release: ChangelogRelease;
  /** The release this app is running, marked so the reader can find it. */
  current?: boolean;
  className?: string;
}): React.JSX.Element {
  return (
    <article
      id={releaseAnchorId(release.version)}
      data-slot="changelog-release"
      aria-label={
        release.version === null
          ? 'Not released yet'
          : `Version ${release.version}`
      }
      className={cn(
        'flex scroll-mt-4 flex-col gap-4 rounded-xl border border-border bg-card p-5',
        current && 'border-primary/40',
        className,
      )}>
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="text-lg font-semibold tabular-nums">
          {release.version ?? 'Not released yet'}
        </h3>
        {current ? <Badge>Current version</Badge> : null}
        {release.date === null ? null : (
          <time
            dateTime={release.date}
            className="ml-auto text-xs text-muted-foreground">
            {formatReleaseDate(release.date)}
          </time>
        )}
      </header>
      {release.sections.map((section) => (
        <section
          key={section.kind}
          data-kind={section.kind}
          className="flex flex-col gap-2">
          <ChangelogKindHeading kind={section.kind} />
          <ul className={ENTRY_LIST_CLASS}>
            {section.entries.map((entry, index) => (
              <ChangelogEntryLine
                key={index}
                kind={section.kind}
                text={entry}
              />
            ))}
          </ul>
        </section>
      ))}
    </article>
  );
}
