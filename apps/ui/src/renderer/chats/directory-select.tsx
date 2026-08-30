import { FolderOpen } from 'lucide-react';

import type { ProfileColor } from '../../shared/contracts';
import { Select } from '../components/ui/select';
import { cn } from '../components/ui/utils';

/**
 * Sentinel values for the two ACTION rows. A path is always absolute, so no
 * real directory can collide with either.
 */
const BROWSE = 'browse';
const CLEAR = 'clear';

/** The trailing segment of an absolute path — the chip's compact label. */
export function folderName(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** How many trailing path segments a menu row keeps before eliding the head. */
const PATH_SEGMENTS = 3;

/**
 * A path shortened from the FRONT — `…/Projects/Geniro/geniro-app`.
 *
 * CSS truncation eats the tail, which for a path is the only part that
 * identifies it: `/var/folders/rr/dcr7_c0x1037…` names nothing at all. The head
 * is what the rows share, so the head is what gives way; the full path stays on
 * the row's tooltip.
 *
 * `segments` is how much tail a caller needs to tell its rows apart, and the
 * only thing that ever differed between this and the copy the context panel
 * used to keep: a 22rem panel listing memory files wants two, since three
 * CLAUDE.md rows are told apart by their parent directory alone. Everything
 * else about eliding a path — that the head gives way, and that it says so with
 * a leading `…` rather than silently — is one rule, and a second copy of it was
 * one chance to write that rule differently. It was: the copy dropped the
 * marker, so a shortened path was indistinguishable from a genuinely short one.
 */
export function shortenPath(path: string, segments = PATH_SEGMENTS): string {
  const parts = path.split('/').filter(Boolean);
  if (parts.length <= segments) {
    return path;
  }
  return `…/${parts.slice(-segments).join('/')}`;
}

/**
 * The composer's directory picker: the chosen directory as a chip, and a menu
 * of the recently used ones plus a row that opens the native dialog.
 *
 * ONE component for both directory chips the composer carries — the working
 * folder and the optional plugin directory. They differ only in their words,
 * their glyph and whether "none" is a legal answer, and everything else about
 * them (how a recent row is labelled, that the current value leads the list,
 * that the trigger shows the leaf while the rows show the path) is a rule that
 * must not be able to differ between two chips sitting side by side.
 */
export function DirectorySelect({
  value,
  recents,
  placeholder,
  searchPlaceholder,
  browseLabel,
  clearLabel,
  icon,
  accents,
  disabled = false,
  onChange,
  onBrowse,
  'aria-label': ariaLabel,
  title,
  className,
}: {
  /** The chosen directory, or null when none is. */
  value: string | null;
  recents: string[];
  /** Trigger text while `value` is null. */
  placeholder: string;
  searchPlaceholder: string;
  /** Label of the row that opens the native dialog. */
  browseLabel: string;
  /**
   * Label of the row that sets the value back to null. Omitted = this picker
   * has no such answer, and the row is absent rather than disabled.
   */
  clearLabel?: string;
  /** Glyph on the trigger and on every recent row. */
  icon: React.ReactNode;
  /**
   * A colour per directory, drawn as the row's left border — for a picker whose
   * directories the user has NAMED (see `config-dir-select.tsx`).
   *
   * A map rather than a list of named things, because this picker knows about
   * directories and nothing else: what a colour MEANS is the caller's, and a
   * generic control that understood agent configurations would be the wrong
   * layer to put that in. Absent, or absent for a given path, leaves the row
   * exactly as it was.
   */
  accents?: ReadonlyMap<string, ProfileColor>;
  disabled?: boolean;
  /** A recents pick, or null from the clear row. */
  onChange: (directory: string | null) => void;
  /** Open the native directory dialog. */
  onBrowse: () => void;
  'aria-label': string;
  title: string;
  className?: string;
}): React.JSX.Element {
  // The current directory leads the list even if it is not among the persisted
  // recents yet (the very first pick), so the menu always shows the checkmark.
  const rows =
    value && !recents.includes(value) ? [value, ...recents] : recents;

  return (
    <Select
      variant="ghost"
      value={value}
      // Truthiness, not `!== null`: settings.json is a file the user (and an
      // older build) can leave a key out of, so an absent directory reaches
      // here as undefined just as legitimately as null, and a leaf name is not
      // something to crash a whole composer over.
      triggerLabel={value ? folderName(value) : undefined}
      placeholder={placeholder}
      searchPlaceholder={searchPlaceholder}
      aria-label={ariaLabel}
      title={title}
      disabled={disabled}
      // Capped AND shrinkable, which the old note here forbade — on the
      // strength of a row that measured its chips and moved whatever did not
      // fit into an overflow menu, so a chip giving up width silently reported
      // a false fit. That row is gone (`composer-rows.tsx` measures nothing
      // now), and with it the reason: this is one of the three chips whose
      // label is USER DATA, so when the row runs short it is the right one to
      // give up width rather than push a neighbour onto a second line. The cap
      // still bounds a deep path, and the full text is one tooltip — or one
      // menu row — away.
      className={cn('max-w-52', className)}
      flexible
      leadingIcon={icon}
      groups={[
        ...(rows.length > 0
          ? [
              {
                label: 'Recents',
                items: rows.map((path) => ({
                  value: path,
                  // More than the leaf: two checkouts of the same repo are both
                  // "geniro-app" and would be indistinguishable as rows.
                  label: shortenPath(path),
                  title: path,
                  icon,
                  // Undefined for a directory the user has not named, which is
                  // exactly what `MenuItem.accent` reads as "no colour" — the
                  // absent and the explicitly-undefined case are one branch
                  // there, so neither this nor a conditional spread would draw
                  // anything.
                  accent: accents?.get(path),
                })),
              },
            ]
          : []),
        {
          items: [
            ...(clearLabel === undefined
              ? []
              : [{ value: CLEAR, label: clearLabel, action: true }]),
            {
              value: BROWSE,
              label: browseLabel,
              icon: <FolderOpen />,
              action: true,
            },
          ],
        },
      ]}
      onValueChange={(next) => {
        if (next === BROWSE) {
          onBrowse();
          return;
        }
        onChange(next === CLEAR ? null : next);
      }}
    />
  );
}
