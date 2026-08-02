import { Folder, FolderOpen } from 'lucide-react';

import { Select } from '../components/ui/select';
import { cn } from '../components/ui/utils';

/**
 * Sentinel value for the "Choose folder…" row. A path is always absolute, so
 * no real folder can ever collide with it.
 */
const BROWSE = 'browse';

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
 * The composer's working-directory picker: the current folder as a chip, and a
 * menu of the recently used ones plus a row that opens the native dialog.
 *
 * This replaced a row of recent-folder suggestion chips under the composer —
 * they consumed a line of the landing screen to say what the chip's own menu
 * says, and only surfaced folders the user had ALREADY opened, never the
 * current one.
 */
export function FolderSelect({
  folder,
  recentFolders,
  disabled = false,
  onChoose,
  onBrowse,
  className,
}: {
  /** Current folder, or null when none has been chosen yet. */
  folder: string | null;
  recentFolders: string[];
  disabled?: boolean;
  onChoose: (folder: string) => void;
  /** Open the native folder dialog. */
  onBrowse: () => void;
  className?: string;
}): React.JSX.Element {
  // The current folder leads the list even if it is not among the persisted
  // recents yet (the very first pick), so the menu always shows the checkmark.
  const recents =
    folder !== null && !recentFolders.includes(folder)
      ? [folder, ...recentFolders]
      : recentFolders;

  return (
    <Select
      variant="ghost"
      value={folder}
      triggerLabel={folder === null ? undefined : folderName(folder)}
      placeholder="Choose folder…"
      searchPlaceholder="Search folders…"
      aria-label="Folder for new chats"
      title={folder ?? 'Choose the folder new chats run in'}
      disabled={disabled}
      // Capped, never shrunk. The row decides what FITS by measuring these
      // chips at their natural width and moving the rest into its overflow
      // menu; a chip that quietly gave up width instead would report a false
      // fit and squeeze itself down to a few letters (it reached 80px, then
      // 0px before that) rather than move. The cap still bounds a deep path —
      // its full text is one tooltip, or one menu row, away.
      className={cn('max-w-52', className)}
      leadingIcon={<Folder />}
      groups={[
        ...(recents.length > 0
          ? [
              {
                label: 'Recents',
                items: recents.map((path) => ({
                  value: path,
                  // More than the leaf: two checkouts of the same repo are both
                  // "geniro-app" and would be indistinguishable as rows.
                  label: shortenPath(path),
                  title: path,
                  icon: <Folder />,
                })),
              },
            ]
          : []),
        {
          items: [
            {
              value: BROWSE,
              label: 'Choose folder…',
              icon: <FolderOpen />,
              action: true,
            },
          ],
        },
      ]}
      onValueChange={(value) => {
        if (value === BROWSE) {
          onBrowse();
          return;
        }
        onChoose(value);
      }}
    />
  );
}
