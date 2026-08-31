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
  named,
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
   * Directories the user has NAMED, which get a row of their own whatever the
   * recents hold (see `config-dir-select.tsx`).
   *
   * This REPLACED an `accents` map that carried only a colour, and the
   * replacement is a bug fix rather than a widening. Rows here were built from
   * `recents` alone — an MRU that only grows when a directory is picked THROUGH
   * this menu — so a directory named in Settings had no row at all, and the
   * colour was being attached to a row that could not exist yet. REPORTED as
   * "I've added a configuration but don't see it in the list", correctly, in
   * the one place it should have appeared first.
   *
   * Still a map keyed by PATH rather than a list of the caller's own objects:
   * this picker knows about directories and nothing else, and what a name or a
   * colour MEANS stays the caller's. The group `label` comes with the entries
   * so there is no state where rows exist under no heading.
   */
  named?: {
    label: string;
    entries: ReadonlyMap<string, { name: string; accent?: ProfileColor }>;
  };
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
  // A NAMED directory is excluded: it has its own row above, and listing it
  // twice would offer one account as two rows, one by name and one by path.
  const rows = (
    value && !recents.includes(value) ? [value, ...recents] : recents
  ).filter((path) => !named?.entries.has(path));

  /**
   * The row that sets the value back to null — for the config picker, the CLI's
   * own account.
   *
   * NOT an `action` row, which is what it used to be, and that was the visible
   * half of what got reported about it. An action renders without a checkmark
   * column (`menu.tsx`), so the one row that is CURRENT whenever nothing is
   * picked was the one row that could never say so — a menu on its default
   * value marked none of its rows. It also had no icon while every row around
   * it did, so its label started where their glyphs were.
   *
   * Being a choice rather than an action also makes it filterable, which is
   * right: typing `def` should find it.
   */
  const clearRow =
    clearLabel === undefined
      ? []
      : [
          {
            value: CLEAR,
            label: clearLabel,
            icon,
            // Stated rather than derived. `Menu` marks a row by comparing its
            // value to the picker's, and this row's value is a SENTINEL — it
            // can never equal the `null` it stands for, so the default
            // comparison would leave it unmarked exactly when it is current.
            checked: value === null,
          },
        ];

  return (
    <Select
      variant="ghost"
      value={value}
      // Truthiness, not `!== null`: settings.json is a file the user (and an
      // older build) can leave a key out of, so an absent directory reaches
      // here as undefined just as legitimately as null, and a leaf name is not
      // something to crash a whole composer over.
      // A named directory says its NAME on the chip. The leaf is what the user
      // is trying to stop reading by naming it — and two accounts routinely
      // live in directories whose leaf is `.claude`.
      triggerLabel={
        value
          ? (named?.entries.get(value)?.name ?? folderName(value))
          : undefined
      }
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
        // FIRST, and unconditional on the recents: a directory the user took
        // the trouble to name is the one they mean to pick. The CLEAR row
        // LEADS them, because it is the same kind of thing — for this picker it
        // is the CLI's own account, a peer of the named ones and not of the
        // browse row it used to sit beside.
        ...(named && named.entries.size > 0
          ? [
              {
                label: named.label,
                items: [
                  ...clearRow,
                  ...[...named.entries].map(([path, entry]) => ({
                    value: path,
                    label: entry.name,
                    // The path is still reachable — a name says which ACCOUNT,
                    // the tooltip says which directory, and only one of those
                    // can fit on a row this narrow.
                    title: path,
                    icon,
                    accent: entry.accent,
                  })),
                ],
              },
            ]
          : []),
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
                })),
              },
            ]
          : []),
        {
          items: [
            // Only when there was no named group to lead — otherwise it is
            // already up there.
            ...(named && named.entries.size > 0 ? [] : clearRow),
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
