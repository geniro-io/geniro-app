import type { DaemonApis } from '../daemon-api';
import type { DaemonClient } from '../daemon-client';
import { SettingsNoticesContext } from './settings-notices-context';
import { useSettingsNotices } from './use-settings-notices';

interface ScopeProps {
  apis: DaemonApis;
  client: DaemonClient | null;
  active: boolean;
  onOpenMemoryConflicts: (() => void) | null;
  remote?: boolean;
  children: React.ReactNode;
}

function LiveSettingsNotices({
  children,
  ...props
}: ScopeProps): React.JSX.Element {
  const store = useSettingsNotices(props);
  return (
    <SettingsNoticesContext.Provider value={store}>
      {children}
    </SettingsNoticesContext.Provider>
  );
}

/** Gives the manager chat's notice rows their readings; any other chat reads none of them. */
export function SettingsNoticesScope({
  enabled,
  children,
  ...props
}: ScopeProps & { enabled: boolean }): React.JSX.Element {
  return enabled ? (
    <LiveSettingsNotices {...props}>{children}</LiveSettingsNotices>
  ) : (
    <>{children}</>
  );
}
