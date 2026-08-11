import { FolderOpen } from 'lucide-react';

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
 */
export function shortenPath(path: string): string {
  const parts = path.split('/').filter(Boolean);
  if (parts.length <= PATH_SEGMENTS) {
    return path;
  }
  return `…/${parts.slice(-PATH_SEGMENTS).join('/')}`;
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
      // Capped, never shrunk. The row decides what FITS by measuring these
      // chips at their natural width and moving the rest into its overflow
      // menu; a chip that quietly gave up width instead would report a false
      // fit and squeeze itself down to a few letters (it reached 80px, then
      // 0px before that) rather than move. The cap still bounds a deep path —
      // its full text is one tooltip, or one menu row, away.
      className={cn('max-w-52', className)}
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
