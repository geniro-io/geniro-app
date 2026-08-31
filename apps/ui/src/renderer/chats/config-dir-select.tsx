import { IdCard } from 'lucide-react';

import type { ConfigProfile } from '../../shared/contracts';
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
  configProfiles = [],
  unavailableReason,
  disabled = false,
  ariaLabel = 'Agent config directory for new chats',
  hint = "Optional: the config directory (account / profile) new chats run as — the CLI's own by default",
  note = null,
  onChange,
  onBrowse,
  className,
}: {
  /** The chosen profile, or null for the CLI's default — the normal state. */
  configDir: string | null;
  recentConfigDirs: string[];
  /**
   * The user's NAMED configurations (Settings → the claude card), so a
   * directory they have named wears its colour here.
   *
   * A left border on the row, and only that — asked for in those words ("там
   * должен быть просто левый бордер вот этого же цвета"). The row still says
   * the PATH: the colour is a way to recognise a directory at a glance, not a
   * replacement for knowing which one it is, and a picker that showed names
   * would leave every unnamed recent looking like a different kind of row.
   *
   * Defaulted to empty, so a caller that has not read them (the graph
   * builder's node inspector, the run-configuration editor) renders exactly
   * what it rendered before rather than being made to thread a list it has no
   * use for yet.
   */
  configProfiles?: readonly ConfigProfile[];
  /**
   * Why this CLI cannot be pointed at a config directory (`null` = it can), or
   * `undefined` while the capability read is still in flight.
   */
  unavailableReason: string | null | undefined;
  disabled?: boolean;
  /**
   * What this chip is choosing FOR. The composer's default speaks for the next
   * chat; the builder's node inspector says so for one node instead — the same
   * control, and the only thing about it that differs is who it is about.
   */
  ariaLabel?: string;
  /**
   * Hover text while no directory is chosen; the path itself once one is.
   *
   * {@link note} is what survives BOTH states — see it for why.
   */
  hint?: string;
  /**
   * A fact about this value the user could not otherwise learn, shown whether
   * or not a directory is chosen.
   *
   * Separate from {@link hint} because the hint is displaced by the path the
   * moment one exists: the chip's own tooltip is the path, which is exactly
   * when a caller most needs to say something ABOUT it. The open-thread chip
   * uses it to name the folder file that pinned a profile over the one the
   * chat asked for — without it the chip shows an account the user never
   * picked and offers no way to find out why.
   */
  note?: string | null;
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
      // The profiles ALWAYS get rows, whatever the recents hold. Before this
      // they got none: rows came from `recentConfigDirs`, which only grows when
      // a directory is picked through this very menu, so a profile named in
      // Settings was invisible here until the user had separately browsed to
      // the same directory — the one action naming it was meant to replace.
      named={{
        label: 'Profiles',
        entries: new Map(
          configProfiles.map((profile) => [
            profile.dir,
            { name: profile.name, accent: profile.color },
          ]),
        ),
      }}
      aria-label={ariaLabel}
      title={[configDir ?? hint, note].filter(Boolean).join(' — ')}
      disabled={disabled}
      className={className}
      onChange={onChange}
      onBrowse={onBrowse}
    />
  );
}
