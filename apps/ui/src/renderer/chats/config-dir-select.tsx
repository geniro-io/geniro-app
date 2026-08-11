import { IdCard } from 'lucide-react';

import { DirectorySelect } from './directory-select';

/**
 * The composer's OPTIONAL config-directory picker: which profile the next
 * chat's CLI runs as, or the CLI's default.
 *
 * A config directory is where a CLI keeps its own credentials, settings,
 * installed plugins and history — so choosing a second one is how a chat runs
 * on a different ACCOUNT (a different subscription) with a different toolbelt,
 * without touching the default profile.
 *
 * Part of a run's identity, like the folder beside it — fixed when the chat is
 * created (the daemon's settings PATCH does not carry it), because every turn
 * of a chat runs on one CLI process whose env named the profile at spawn.
 *
 * WITH NO CAPABILITY, THE CHIP IS ABSENT ENTIRELY — not disabled, not a static
 * badge. The daemon answers per CLI (`GET /v1/capabilities` → `configDirs[]`,
 * itself the adapter's own `configDir.unavailableReason`), so this renderer
 * never decides by agent name; a CLI without the mechanism gets no control at
 * all, the same rule the effort chip follows for cursor. `undefined` — the
 * answer has not arrived — is also no chip, since the honest rendering before
 * the daemon has spoken is nothing rather than a guess.
 */
export function ConfigDirSelect({
  configDir,
  recentConfigDirs,
  unavailableReason,
  disabled = false,
  onChange,
  onBrowse,
  className,
}: {
  /** The chosen profile, or null for the CLI's default — the normal state. */
  configDir: string | null;
  recentConfigDirs: string[];
  /**
   * Why this CLI cannot be pointed at a config directory (`null` = it can), or
   * `undefined` while the capability read is still in flight.
   */
  unavailableReason: string | null | undefined;
  disabled?: boolean;
  /** A pick, or null from the "Default profile" row. */
  onChange: (configDir: string | null) => void;
  /** Open the native directory dialog. */
  onBrowse: () => void;
  className?: string;
}): React.JSX.Element | null {
  if (unavailableReason !== null) {
    return null;
  }
  return (
    <DirectorySelect
      value={configDir}
      recents={recentConfigDirs}
      placeholder="Default profile"
      searchPlaceholder="Search config directories…"
      browseLabel="Choose config directory…"
      // The one thing this picker has that the folder chip must not: the CLI's
      // own default is a real answer here, and it is how the user gets back out
      // of a profile they picked once.
      clearLabel="Default profile"
      icon={<IdCard />}
      aria-label="Agent config directory for new chats"
      title={
        configDir ??
        "Optional: the config directory (account / profile) new chats run as — the CLI's own by default"
      }
      disabled={disabled}
      className={className}
      onChange={onChange}
      onBrowse={onBrowse}
    />
  );
}
