import { Check } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { DaemonHandle } from '../../shared/contracts';
import {
  CLI_KINDS,
  type CliDetection,
  type CliKind,
  DAEMON_INSPECT_PORT,
  resolveDaemonInspect,
  type Settings as SettingsShape,
} from '../../shared/contracts';
import { AgentConfigList } from '../components/agent-config-list';
import { ErrorText } from '../components/error-text';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Label } from '../components/ui/label';
import { ProgressBar } from '../components/ui/progress-bar';
import { Switch } from '../components/ui/switch';
import { cn } from '../components/ui/utils';
import { createDaemonApis } from '../daemon-api';
import { useConfigDirCapability } from '../graphs/use-config-dir-capability';
import { updateStatusLine } from '../updates/update-status';
import { useUpdateState } from '../updates/use-update-state';
import { useCliLogin } from './use-cli-login';

function normalizedCliPaths(
  paths: Partial<Record<CliKind, string>>,
): Partial<Record<CliKind, string>> {
  const cliPaths: Partial<Record<CliKind, string>> = {};
  for (const kind of CLI_KINDS) {
    const path = paths[kind]?.trim();
    if (path) {
      cliPaths[kind] = path;
    }
  }
  return cliPaths;
}

/**
 * Post-onboarding configuration. Reuses the onboarding agent-config UI
 * (`AgentConfigList`) so binary paths are edited the same way everywhere, and
 * adds the one control onboarding does not offer: signing a CLI itself back
 * in, in the user's own terminal — the decided placement for that action.
 * Everything is saved automatically — no Save button: the update toggle
 * persists on flip, binary-path edits persist debounced. Persists via
 * updateSettings — never `completeOnboarding`, which is first-run only.
 */
export function Settings({
  handle,
}: {
  handle: DaemonHandle | null;
}): React.JSX.Element {
  const apis = useMemo(
    () => (handle ? createDaemonApis(handle) : null),
    [handle],
  );
  const [clis, setClis] = useState<CliDetection[] | null>(null);
  const [open, setOpen] = useState<Partial<Record<CliKind, boolean>>>({});
  const [binaryPaths, setBinaryPaths] = useState<
    Partial<Record<CliKind, string>>
  >({});
  const [checkForUpdates, setCheckForUpdates] = useState(true);
  const [notificationsEnabled, setNotificationsEnabled] = useState(true);
  // The live update state, pushed by main — the same one the app-wide strip
  // reads, so this screen cannot show a stale reading of a running download.
  const update = useUpdateState();
  const updateLine = update.state ? updateStatusLine(update.state) : '';
  const updateWorking =
    update.state?.phase === 'downloading' ||
    update.state?.phase === 'installing';
  // A check pressed mid-download would be answered with the download's own
  // state and read as having done nothing.
  const updateBusy = updateWorking || update.state?.phase === 'checking';
  // The STORED tri-state, not the effective one: `null` means "not chosen",
  // and the switch below renders what that resolves to for this build.
  const [storedInspect, setStoredInspect] = useState<boolean | null>(null);
  const [isPackaged, setIsPackaged] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);
  const checkForUpdatesDirtyRef = useRef(false);
  const notificationsDirtyRef = useRef(false);
  const daemonInspectDirtyRef = useRef(false);
  const persistGenerationRef = useRef({
    cliPaths: 0,
    checkForUpdates: 0,
    notificationsEnabled: 0,
    daemonInspect: 0,
    other: 0,
  });

  // What the daemon was actually spawned with — the switch must report the
  // port's real state, not the stored `null`.
  const inspectEnabled = resolveDaemonInspect(storedInspect, isPackaged);

  // Latest binary paths for the debounced persist timer (it fires after the
  // state that triggered it has committed).
  const binaryPathsRef = useRef(binaryPaths);
  useEffect(() => {
    binaryPathsRef.current = binaryPaths;
  }, [binaryPaths]);
  const pathTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (pathTimer.current) {
        clearTimeout(pathTimer.current);
        pathTimer.current = null;
        void window.geniro
          .updateSettings({
            cliPaths: normalizedCliPaths(binaryPathsRef.current),
          })
          .catch((err: unknown) => {
            console.error('failed to flush CLI path settings on unmount', err);
          });
      }
      if (flashTimer.current) {
        clearTimeout(flashTimer.current);
      }
    },
    [],
  );

  useEffect(() => {
    void window.geniro.getSettings().then((s) => {
      // Seed saved overrides; the detection effect backfills the rest.
      setBinaryPaths((prev) => ({ ...s.cliPaths, ...prev }));
      if (!checkForUpdatesDirtyRef.current) {
        setCheckForUpdates(s.checkForUpdates);
      }
      if (!notificationsDirtyRef.current) {
        setNotificationsEnabled(s.notificationsEnabled);
      }
      if (!daemonInspectDirtyRef.current) {
        setStoredInspect(s.daemonInspect);
      }
    });
    void window.geniro.getStatus().then((s) => setIsPackaged(s.isPackaged));
    void window.geniro.detectClis().then(setClis);
  }, []);

  // Pre-fill each detected binary's resolved path into its (empty) field, so a
  // found agent shows exactly which binary will be used. Never clobbers a saved
  // override or a value the user typed. (Detected paths are NOT auto-persisted —
  // only user edits are; an unpinned agent re-resolves on PATH each launch.)
  useEffect(() => {
    if (!clis) {
      return;
    }
    setBinaryPaths((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const d of clis) {
        if (d.found && d.path && !next[d.kind]) {
          next[d.kind] = d.path;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [clis]);

  const flashSaved = useCallback((): void => {
    setSavedFlash(true);
    if (flashTimer.current) {
      clearTimeout(flashTimer.current);
    }
    flashTimer.current = setTimeout(() => setSavedFlash(false), 1500);
  }, []);

  const persist = useCallback(
    async (patch: Partial<SettingsShape>): Promise<void> => {
      const domain =
        patch.cliPaths !== undefined
          ? 'cliPaths'
          : patch.checkForUpdates !== undefined
            ? 'checkForUpdates'
            : patch.notificationsEnabled !== undefined
              ? 'notificationsEnabled'
              : patch.daemonInspect !== undefined
                ? 'daemonInspect'
                : 'other';
      const generation = ++persistGenerationRef.current[domain];
      setError(null);
      try {
        await window.geniro.updateSettings(patch);
        if (generation !== persistGenerationRef.current[domain]) {
          return;
        }
        flashSaved();
      } catch (err) {
        if (generation === persistGenerationRef.current[domain]) {
          setError(String(err));
        }
      }
    },
    [flashSaved],
  );

  /** Debounced auto-save of the binary-path overrides (reads the latest ref). */
  const schedulePathPersist = useCallback((): void => {
    if (pathTimer.current) {
      clearTimeout(pathTimer.current);
    }
    pathTimer.current = setTimeout(() => {
      pathTimer.current = null;
      void persist({
        cliPaths: normalizedCliPaths(binaryPathsRef.current),
      });
    }, 600);
  }, [persist]);

  const toggle = useCallback((kind: CliKind): void => {
    setOpen((prev) => ({ ...prev, [kind]: !prev[kind] }));
  }, []);

  const refreshClis = useCallback(async (): Promise<void> => {
    setClis(null);
    setClis(await window.geniro.detectClis());
  }, []);

  /**
   * Re-probe when this window regains focus.
   *
   * The in-app flows re-probe themselves when they settle, so this is not their
   * mechanism — it is the backstop for every account change that happens where
   * this app cannot see it: the terminal fallback, a `claude auth login` the user
   * ran in their own shell, a token that expired while the window was in the
   * background. Focus-return is exactly when the answer may have changed, since
   * leaving and coming back is the shape of all three.
   *
   * Not scoped to the account buttons: a binary installed or a `PATH` edited
   * while the window was in the background changes detection too, and the probe
   * is two `execFile`s with a 5s ceiling.
   *
   * Deliberately does NOT clear `clis` first, unlike {@link refreshClis} — a
   * flash of "Checking…" on every window focus would be noise, and the stale
   * reading it briefly keeps is the one already on screen.
   */
  useEffect(() => {
    const onFocus = (): void => {
      void window.geniro.detectClis().then(setClis);
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  const browse = useCallback(
    async (kind: CliKind): Promise<void> => {
      const chosen = await window.geniro.pickAgentBinary();
      if (chosen) {
        setBinaryPaths((prev) => ({ ...prev, [kind]: chosen }));
        schedulePathPersist();
      }
    },
    [schedulePathPersist],
  );

  /**
   * The CLIs whose account is per-config-directory, so the account row can name
   * WHICH profile it is reporting on.
   *
   * Asked of the daemon rather than decided here: it is the adapters that know
   * whether pointing a run at a config directory changes the account
   * (`configDirs[].unavailableReason`), and cursor-agent's answer is that it does
   * NOT — it reads the directory but keeps the account outside it. A renderer
   * that allowlisted claude by name would be a second copy of that rule, free to
   * disagree with the one the executor enforces.
   *
   * The action itself is deliberately NOT scoped: Settings configures the CLI,
   * so its sign-in and sign-out always act on the default profile. A run on
   * another profile has its own, profile-correct sign-in on the error row that
   * reported the lapsed session (`Chats.signInToCli`, which passes the run's
   * `configDir`). This label is what keeps the two from being confused.
   */
  /**
   * The in-place sign-in. `refreshClis` is its settle handler: the daemon only
   * reports that the command completed, so the authoritative answer comes from
   * re-asking the CLI — the same probe the card's status line already reads.
   */
  const login = useCliLogin(apis, () => void refreshClis());

  const configDirCapability = useConfigDirCapability(
    apis?.capabilities ?? null,
  );
  const profileScopedKinds = useMemo(
    () =>
      new Set(
        CLI_KINDS.filter(
          (kind) => configDirCapability.unavailableReasonFor(kind) === null,
        ),
      ),
    // A new predicate identity per render would rebuild this every time; the
    // capability answer is what actually changes it.
    [configDirCapability.unavailableReasonFor],
  );

  /**
   * Sign one CLI in, IN PLACE — the daemon runs it and this screen shows the
   * progress, so no terminal window opens.
   *
   * The resolve-and-hand-to-a-terminal path it replaced is still there and still
   * reachable: it is what the chat surface uses for a run on another profile, and
   * what the sign-in panel's own failure text points at. No config directory is
   * passed — Settings configures the CLI itself, so this is the default profile.
   */
  const signInToCli = useCallback(
    async (kind: CliKind): Promise<void> => {
      await login.start(kind);
    },
    [login],
  );

  /**
   * Sign one CLI out, in place.
   *
   * No progress panel and no window, because there is nothing to watch: probed on
   * claude 2.1.228 with stdin closed and no TTY, `auth logout` exits 0 in well
   * under a second. What the user sees is the card's own status line changing,
   * which is the answer they actually wanted — and it comes from re-probing the
   * CLI rather than from trusting the exit code.
   */
  const signOutFromCli = useCallback(
    async (kind: CliKind): Promise<void> => {
      if (!apis) {
        return;
      }
      try {
        const result = await apis.cliAuth.cliLogout({ agent: kind as never });
        if (!result.ok) {
          setError(result.unavailableReason);
        }
      } catch (err) {
        setError(String(err));
      }
      await refreshClis();
    },
    [apis, refreshClis],
  );

  const onToggleUpdates = useCallback(
    (next: boolean): void => {
      checkForUpdatesDirtyRef.current = true;
      setCheckForUpdates(next);
      void persist({ checkForUpdates: next });
    },
    [persist],
  );

  const onToggleNotifications = useCallback(
    (next: boolean): void => {
      notificationsDirtyRef.current = true;
      setNotificationsEnabled(next);
      // Nothing to restart and nothing to apply: main reads this setting at the
      // moment it is about to post, so the flip takes effect on the very next
      // question or turn end.
      void persist({ notificationsEnabled: next });
    },
    [persist],
  );

  const onToggleInspect = useCallback(
    (next: boolean): void => {
      daemonInspectDirtyRef.current = true;
      // Flipping the switch always writes an EXPLICIT boolean, never back to
      // `null`. Touching it is the choice; leaving it alone is what keeps the
      // per-build default. Writing `null` here would make the toggle
      // un-flippable in dev, where auto already resolves to on.
      setStoredInspect(next);
      // Main restarts the daemon on this key — an inspector is a launch flag,
      // so there is nothing to apply to the process already running.
      void persist({ daemonInspect: next });
    },
    [persist],
  );

  return (
    <div className="mx-auto flex h-full w-full max-w-2xl flex-col gap-6 overflow-y-auto px-6 py-8">
      <header className="flex flex-col gap-1">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl">Settings</h1>
          {savedFlash && !error ? (
            <span className="flex items-center gap-1.5 text-sm text-success">
              <Check className="size-4" />
              Saved
            </span>
          ) : null}
        </div>
        <p className="text-sm text-muted-foreground">
          Configure the CLI agents Geniro drives. Changes are saved
          automatically.
        </p>
      </header>

      {/* The sign-in's own error lives in its progress panel — but a sign-in that
          failed to START has no panel to live in, and would otherwise be a
          button press with no visible outcome. It falls through to here. */}
      {(error ?? (login.login === null ? login.error : null)) ? (
        <ErrorText>
          {error ?? (login.login === null ? login.error : null)}
        </ErrorText>
      ) : null}

      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-medium">Agents</h2>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void refreshClis()}>
            Re-check
          </Button>
        </div>
        <AgentConfigList
          clis={clis}
          open={open}
          onToggle={toggle}
          binaryPaths={binaryPaths}
          onBinaryPathChange={(kind, value) => {
            setBinaryPaths((prev) => ({ ...prev, [kind]: value }));
            schedulePathPersist();
          }}
          onBrowse={(kind) => void browse(kind)}
          // Withheld until the daemon answers: `AgentConfigList` renders no
          // control for an absent handler, which is the honest state on a slow
          // launch. Passed unconditionally, the button would resolve nothing
          // and report nothing — `signInToCli` cannot even set an error,
          // because it has no transport to fail on.
          onSignIn={apis ? (kind) => void signInToCli(kind) : undefined}
          onSignOut={apis ? (kind) => void signOutFromCli(kind) : undefined}
          profileScopedKinds={profileScopedKinds}
          login={
            login.login
              ? {
                  kind: login.login.kind,
                  session: login.login.session,
                  error: login.error,
                  onSubmitCode: (code) => void login.submitCode(code),
                  onCancel: () => void login.cancel(),
                  onDismiss: login.dismiss,
                }
              : null
          }
        />
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-medium">Notifications</h2>
        <div className="flex items-center gap-3">
          <Switch
            id="settings-notifications"
            checked={notificationsEnabled}
            onCheckedChange={onToggleNotifications}
          />
          <Label htmlFor="settings-notifications" className="cursor-pointer">
            Show system notifications
          </Label>
        </div>
        <p className="text-xs text-muted-foreground">
          A macOS banner when an agent stops to ask you something and when a
          thread’s turn ends — so a run parked on a question does not sit
          unanswered while you are in another app. Clicking one opens that chat.
        </p>
        <p className="text-xs text-muted-foreground">
          Nothing is posted for the chat you are already looking at, or for a
          turn you stopped yourself.
        </p>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-medium">Updates</h2>
        <div className="flex items-center gap-3">
          <Switch
            id="settings-check-updates"
            checked={checkForUpdates}
            onCheckedChange={onToggleUpdates}
          />
          <Label htmlFor="settings-check-updates" className="cursor-pointer">
            Check for updates automatically
          </Label>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="ml-auto"
            disabled={updateBusy}
            onClick={() => void update.check()}>
            {update.state?.phase === 'checking' ? 'Checking…' : 'Check now'}
          </Button>
          {/* The same action as the strip's, on the screen a user opens when
              they went LOOKING for it — not a second mechanism: both call the
              one service, and both are gated on the same `canInstall`. */}
          {update.state?.phase === 'available' && update.state.canInstall ? (
            <Button
              type="button"
              variant="default"
              size="sm"
              onClick={() => void update.install()}>
              Update now
            </Button>
          ) : null}
        </div>
        <p className="text-xs text-muted-foreground">
          Geniro checks GitHub Releases on launch and every few hours. An update
          downloads, is verified against its published checksum and replaces the
          app in place — nothing is installed until you press Update now.
        </p>
        {update.state && updateLine ? (
          <p
            className={cn(
              'text-xs',
              update.state.phase === 'error'
                ? 'text-destructive'
                : 'text-muted-foreground',
            )}>
            {updateLine}
            {update.state.message ? ` ${update.state.message}` : null}
          </p>
        ) : null}
        {/* Only while something is moving: a bar sitting at 0% next to an
            offer would suggest a download nobody started. */}
        {updateWorking && update.state ? (
          <ProgressBar
            fraction={
              update.state.phase === 'installing' ? null : update.state.progress
            }
            label={`Update ${update.state.version} progress`}
          />
        ) : null}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-medium">Diagnostics</h2>
        <div className="flex items-center gap-3">
          <Switch
            id="settings-daemon-inspect"
            checked={inspectEnabled}
            onCheckedChange={onToggleInspect}
          />
          <Label htmlFor="settings-daemon-inspect" className="cursor-pointer">
            Attach a debugger to the daemon
          </Label>
          {storedInspect === null ? (
            // Named so the state is legible: the switch is showing a default
            // this build chose, not something the user set. Without it, a
            // developer who never opened Settings has no way to learn the
            // port is open.
            <Badge variant="secondary">
              default for {isPackaged ? 'the installed app' : 'dev'}
            </Badge>
          ) : null}
        </div>
        <p className="text-xs text-muted-foreground">
          Runs the daemon with a Node inspector on{' '}
          <code className="rounded bg-muted px-1 py-0.5">
            127.0.0.1:{DAEMON_INSPECT_PORT}
          </code>
          , so Chrome DevTools can attach to it from{' '}
          <code className="rounded bg-muted px-1 py-0.5">chrome://inspect</code>{' '}
          — breakpoints, profiler and heap snapshots over the daemon itself.
          This window’s own DevTools (⌥⌘I) cannot see the daemon: it is a
          separate process.
        </p>
        <p className="text-xs text-muted-foreground">
          On by default in development and off in the installed app. Toggling it
          restarts the daemon, and while the port is open any process on this
          machine can run code inside the daemon — which is why a shipped
          install, where nobody is debugging, does not open one.
        </p>
      </section>
    </div>
  );
}
