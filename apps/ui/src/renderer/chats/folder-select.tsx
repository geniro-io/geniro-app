import { Folder } from 'lucide-react';

import { DirectorySelect } from './directory-select';

/**
 * The composer's working-directory picker: the current folder as a chip, and a
 * menu of the recently used ones plus a row that opens the native dialog.
 *
 * This replaced a row of recent-folder suggestion chips under the composer —
 * they consumed a line of the landing screen to say what the chip's own menu
 * says, and only surfaced folders the user had ALREADY opened, never the
 * current one.
 *
 * NO clear row: a chat has to run somewhere, so "no folder" is not an answer
 * the picker may offer (the config-directory chip beside it does have one,
 * because the CLI's own profile is its normal state).
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
  return (
    <DirectorySelect
      value={folder}
      recents={recentFolders}
      placeholder="Choose folder…"
      searchPlaceholder="Search folders…"
      browseLabel="Choose folder…"
      icon={<Folder />}
      aria-label="Folder for new chats"
      title={folder ?? 'Choose the folder new chats run in'}
      disabled={disabled}
      className={className}
      onBrowse={onBrowse}
      // Never null: this picker offers no clear row, so the only values it can
      // emit are the recent paths it was handed.
      onChange={(next) => {
        if (next !== null) {
          onChoose(next);
        }
      }}
    />
  );
}
