import { Search } from 'lucide-react';
import type * as React from 'react';

import { EmptyState } from './empty-state';
import { NoteBox } from './note-box';
import { Input } from './ui/input';
import { Spinner } from './ui/spinner';
import { cn } from './ui/utils';

/**
 * A search field, a scrolling list of results, and the quote that says WHY a
 * result is one.
 *
 * Extracted when the transcript search became the second place needing all
 * three — the session picker was the first, and had them inline. They are three
 * exports rather than one panel because the arrangement genuinely differs: the
 * picker's field shares a row with an agent chooser, while the transcript's
 * stands alone.
 *
 * What must not differ is the set of STATES the list can be in, which is the
 * part that was worth extracting: loading, unavailable, empty and rows, plus a
 * partial note under them — a second implementation would sooner or later grow
 * four of those and forget the fifth. That set is not particular to SEARCHING,
 * which is why {@link SearchResultList} also draws the changed-files view: any
 * list fetched from somewhere can be loading, unanswerable, empty, or short.
 */

/** A search box with its magnifier — the caller places it. */
export function SearchField({
  value,
  onValueChange,
  label,
  placeholder,
  className,
  autoFocus,
}: {
  value: string;
  onValueChange: (value: string) => void;
  /** Accessible name — every caller searches something different. */
  label: string;
  placeholder: string;
  className?: string;
  autoFocus?: boolean;
}): React.JSX.Element {
  return (
    <label className={cn('relative flex items-center', className)}>
      <Search
        className="pointer-events-none absolute left-2 size-4 text-muted-foreground"
        aria-hidden="true"
      />
      <Input
        aria-label={label}
        className="pl-8"
        placeholder={placeholder}
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
        autoFocus={autoFocus}
      />
    </label>
  );
}

/**
 * The bordered box the hits scroll in, and the four things it can be showing.
 *
 * `unavailableReason` REPLACES the list — nothing could be searched, so there is
 * no list to qualify — while `partialReason` sits UNDER it, because it is true
 * whether the list is full or empty: a user whose answer is genuinely
 * incomplete would otherwise read a short, correct list as the whole of it.
 * The two are a vocabulary the daemon already speaks on both search routes, so
 * keeping them distinct here is what stops one surface collapsing them.
 */
export function SearchResultList({
  loading,
  loadingLabel,
  unavailableReason,
  partialReason,
  isEmpty,
  empty,
  children,
  className,
}: {
  loading: boolean;
  loadingLabel: string;
  /** Nothing could be searched at all — replaces the rows. */
  unavailableReason?: string | null;
  /** The rows are real but not all of them — sits under the rows. */
  partialReason?: string | null;
  isEmpty: boolean;
  /** What to show when the search ran and matched nothing. */
  empty: React.ReactNode;
  /** The rows, as the caller's own list element. */
  children: React.ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <>
      <div
        className={cn(
          'min-h-[16rem] flex-1 overflow-y-auto rounded-md border border-border',
          className,
        )}>
        {loading ? (
          <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
            <Spinner /> {loadingLabel}
          </div>
        ) : unavailableReason ? (
          <EmptyState>{unavailableReason}</EmptyState>
        ) : isEmpty ? (
          empty
        ) : (
          children
        )}
      </div>
      {partialReason ? (
        <NoteBox className="shrink-0">{partialReason}</NoteBox>
      ) : null}
    </>
  );
}

/**
 * The matching words, quoted under a hit's own heading.
 *
 * A search matches text in the middle of a conversation while a row's own title
 * is its opening line — so without the quote, a list of correct matches reads
 * as a list of irrelevant ones.
 */
export function SearchSnippet({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <span
      data-slot="search-snippet"
      className={cn(
        'line-clamp-2 w-full border-l-2 border-border pl-2 text-xs text-muted-foreground italic',
        className,
      )}>
      {children}
    </span>
  );
}
