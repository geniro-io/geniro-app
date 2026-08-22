import { Folder, Search } from 'lucide-react';
import * as React from 'react';

import type { CliKind } from '../../shared/contracts';
import { CLI_KINDS } from '../../shared/contracts';
import { EmptyState } from '../components/empty-state';
import { ErrorText } from '../components/error-text';
import { NoteBox } from '../components/note-box';
import { Dialog } from '../components/ui/dialog';
import { Input } from '../components/ui/input';
import { Select } from '../components/ui/select';
import { Spinner } from '../components/ui/spinner';
import { cn } from '../components/ui/utils';
import { shortenPath } from './directory-select';
import { formatRelativeTime } from './relative-time';
import type { MergedSessions, ProfiledSession } from './session-search';

/**
 * Pick a conversation the user already had in their terminal, and carry it on
 * here.
 *
 * Deliberately a separate control from the sidebar's `+`, which stays a
 * one-click new thread: this one has a question to ask (which conversation?)
 * and the other must never grow one.
 *
 * Two controls, not three. A folder-scope picker sat beside the agent one and
 * was removed once the dialog was wide enough to show each row's whole path:
 * scoping and searching answered the same question, and the scope was the
 * worse half of the pair — it could only ever be the ONE folder the composer
 * happened to point at, so continuing something from a different project meant
 * first setting the composer to a folder the user was not going to work in.
 * The search matches the path as well as the title, which covers the scope's
 * whole job and every folder besides.
 *
 * **The search is the DAEMON's, and this component holds none of its own.** It
 * used to filter the rows it had been handed, which could only ever match the
 * two fields a row displays — and a row's title is the conversation's OPENING
 * PROMPT, so "the thread where we worked out the asar bug" was unfindable
 * unless those were the words it had been opened with. Only the daemon can read
 * what was said inside a conversation, so the query is a question put to it
 * (`AgentSessionsInput.query`) rather than a predicate applied to its answer.
 * The caller debounces; every row that arrives is on the list.
 *
 * It also shows the rows of EVERY profile at once — see `session-search.ts` for
 * the fan-out and why it lives on this side.
 */
export function SessionPicker({
  open,
  agent,
  onAgentChange,
  profiles,
  query,
  onQueryChange,
  listing,
  loading,
  error,
  busyId,
  onClose,
  onResume,
}: {
  open: boolean;
  agent: CliKind;
  onAgentChange: (agent: CliKind) => void;
  /** Every profile the list was taken from; null is the CLI's own default. */
  profiles: readonly (string | null)[];
  query: string;
  onQueryChange: (query: string) => void;
  listing: MergedSessions | null;
  loading: boolean;
  error: string | null;
  /** The row being imported right now — the dialog stays up while it runs. */
  busyId: string | null;
  onClose: () => void;
  onResume: (row: ProfiledSession) => void;
}): React.JSX.Element {
  const rows = listing?.sessions ?? [];

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Continue a session"
      // Wide enough for a row to state its path, which is what replaced the
      // folder-scope control: a leaf name alone ("app", "src") does not
      // identify a project among the several checkouts a machine holds.
      // `max-w-none` is load-bearing — Dialog's own `max-w-md` caps the card at
      // 28rem, so a width alone changed nothing on screen.
      className="h-[min(56rem,100%)] w-[min(60rem,calc(100vw-3rem))] max-w-none">
      {/* `h-full`: this dialog manages its own scrolling — the list moves and
          everything around it stays put — so it has to fill the body exactly.
          Short of that the body scrolled too, and the two bars sat side by
          side. */}
      <div className="flex h-full min-h-0 flex-col gap-3">
        {/* `shrink-0` on everything around the list: they are one or two lines
            each and the list is what the room is for, so a short window has to
            take it out of the list rather than squeezing the sentence that
            explains the dialog or the row that filters it. */}
        <p className="shrink-0 text-sm text-muted-foreground">
          Threads you already have with these CLIs on this machine. Picking one
          opens it here and carries on where it left off.
        </p>

        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {/*
            Opens DOWNWARD. `Menu`'s default is upward, which is right for the
            composer's chips at the bottom of the window and wrong for a control
            at the top of a dialog — measured on screen, the panel covered the
            dialog's own title bar.
          */}
          {/*
            Boxed to its own width: the `default` trigger is `w-full` by design
            (it is a form field), which in this row made it a full-width line of
            its own and pushed the search box onto a second one.
          */}
          <div className="w-44 shrink-0">
            <Select
              aria-label="Agent"
              side="bottom"
              value={agent}
              onValueChange={(value: string) => onAgentChange(value as CliKind)}
              groups={[
                {
                  items: CLI_KINDS.map((kind) => ({
                    value: kind,
                    label: kind,
                  })),
                },
              ]}
            />
          </div>
          <label className="relative flex min-w-[12rem] flex-1 items-center">
            <Search
              className="pointer-events-none absolute left-2 size-4 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              aria-label="Search sessions"
              className="pl-8"
              placeholder="Search by what was said, or by folder…"
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
            />
          </label>
        </div>

        {/*
          Which stores were searched, said out loud. The picker used to name the
          ONE profile it had asked, which was accurate and told the user nothing
          about the accounts it had not — the reported "i can see only one
          claude profile there". A single default profile is the state a user
          has without ever choosing one, so naming it would be chrome; two or
          more is a fact about the list in front of them.
        */}
        {profiles.length < 2 ? null : (
          // `break-all` on the paths: each is one unbroken token with no spaces
          // to wrap at, so without it a real profile path runs straight out
          // through the side of the dialog.
          <p className="shrink-0 text-xs text-muted-foreground">
            Across {profiles.length} profiles:{' '}
            {profiles.map((profile, index) => (
              <React.Fragment key={profile ?? 'default'}>
                {index === 0 ? null : ', '}
                <code className="break-all">
                  {profile === null ? 'default' : shortenPath(profile)}
                </code>
              </React.Fragment>
            ))}
            .
          </p>
        )}

        {error ? <ErrorText className="shrink-0">{error}</ErrorText> : null}

        {/*
          The LIST scrolls, and it is the ONLY thing here that does: hundreds of
          rows otherwise push the search field off the top of the card, so
          filtering a long list means scrolling back up to reach the control
          that does it. `flex-1` rather than a `52vh` cap — the cap was a guess
          at the window that always came in under the room actually available,
          so the list showed fewer sessions than it could AND the leftover
          content gave the dialog body a second scrollbar beside this one.
        */}
        <div className="min-h-[16rem] flex-1 overflow-y-auto rounded-md border border-border">
          {loading ? (
            <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
              <Spinner />{' '}
              {query === ''
                ? `Asking ${agent} what it has…`
                : `Searching ${agent}’s conversations…`}
            </div>
          ) : listing?.unavailableReason ? (
            <EmptyState>{listing.unavailableReason}</EmptyState>
          ) : rows.length === 0 ? (
            <EmptyState className="flex-col gap-1">
              <span className="text-foreground">
                {query === ''
                  ? `No ${agent} sessions`
                  : 'Nothing matches that search'}
              </span>
              <span>
                {query === ''
                  ? 'Sessions you start in your terminal show up here.'
                  : 'Try fewer words, or clear the search.'}
              </span>
            </EmptyState>
          ) : (
            <ul className="m-0 flex list-none flex-col p-1">
              {rows.map((row) => (
                <SessionRow
                  key={`${row.configDir ?? ''}:${row.session.id}`}
                  row={row}
                  showProfile={profiles.length > 1}
                  busy={busyId === row.session.id}
                  disabled={busyId !== null && busyId !== row.session.id}
                  onResume={onResume}
                />
              ))}
            </ul>
          )}
        </div>

        {/*
          The listing is complete for the store it reached and this CLI may keep
          another. Said UNDER the rows rather than in place of them, because it
          is true whether the list is full or empty — and a user whose terminal
          history is all in that other store would otherwise read a short,
          correct list as a broken feature.
        */}
        {listing?.partialReason ? (
          <NoteBox className="shrink-0">{listing.partialReason}</NoteBox>
        ) : null}
      </div>
    </Dialog>
  );
}

/** One conversation, as a row that says what it was about and where. */
function SessionRow({
  row,
  showProfile,
  busy,
  disabled,
  onResume,
}: {
  row: ProfiledSession;
  /** Only when more than one store was searched — see the header note. */
  showProfile: boolean;
  busy: boolean;
  disabled: boolean;
  onResume: (row: ProfiledSession) => void;
}): React.JSX.Element {
  const { session } = row;
  // A session the CLI recorded no folder for cannot be resumed anywhere
  // sensible, so the row says so instead of offering a button that would open a
  // conversation about one project inside another.
  const resumable = session.cwd !== null;
  return (
    <li>
      <button
        type="button"
        disabled={disabled || busy || !resumable}
        title={resumable ? undefined : 'This CLI recorded no folder for it'}
        onClick={() => onResume(row)}
        className={cn(
          'flex w-full flex-col items-start gap-0.5 rounded-md px-3 py-2 text-left',
          'hover:bg-sidebar-accent focus-visible:bg-sidebar-accent',
          'disabled:pointer-events-none disabled:opacity-50',
        )}>
        <span className="line-clamp-2 w-full text-sm text-foreground">
          {session.title ?? 'Untitled conversation'}
        </span>
        {/*
          WHY this row is here, when the reason is not the line above it. A
          content search matches words said in the middle of a conversation
          while the row's own title is its opening prompt — so without the
          quote, a list of correct matches reads as a list of irrelevant ones.
          Absent when the title or the folder already explains the match, which
          is what keeps an unsearched list looking exactly as it did.
        */}
        {session.snippet === null ? null : (
          <span
            data-slot="session-snippet"
            className="line-clamp-2 w-full border-l-2 border-border pl-2 text-xs text-muted-foreground italic">
            {session.snippet}
          </span>
        )}
        <span className="flex w-full items-center gap-1.5 text-xs text-muted-foreground">
          {busy ? <Spinner /> : <Folder className="size-3 shrink-0" />}
          {/*
            The path, elided from the FRONT by the composer's own helper — with
            no folder scope left, this line is how one project is told from
            another, and CSS truncation would eat the only end that says which.
          */}
          <span className="truncate" title={session.cwd ?? undefined}>
            {session.cwd === null
              ? 'folder not recorded'
              : shortenPath(session.cwd)}
          </span>
          {session.updatedAt === null ? null : (
            <>
              <span aria-hidden="true">·</span>
              <span className="shrink-0">
                {formatRelativeTime(new Date(session.updatedAt).toISOString())}
              </span>
            </>
          )}
          {/*
            WHICH account this conversation belongs to, once more than one was
            searched. Last on the line and only then: with a single profile it
            is the same word on every row, and the row already has two facts to
            carry.
          */}
          {showProfile ? (
            <>
              <span aria-hidden="true">·</span>
              <span
                data-slot="session-profile"
                className="shrink-0 truncate"
                title={row.configDir ?? 'The default profile'}>
                {row.configDir === null
                  ? 'default'
                  : shortenPath(row.configDir)}
              </span>
            </>
          ) : null}
        </span>
      </button>
    </li>
  );
}
