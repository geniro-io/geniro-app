import { Check } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { DaemonHandle } from '../../shared/contracts';
import {
  CLI_KINDS,
  type CliDetection,
  type CliKind,
  DAEMON_INSPECT_PORT,
  hasControlCharacters,
  MAX_CUSTOM_INSTRUCTIONS_CHARS,
  resolveDaemonInspect,
  type RunConfig,
  type Settings as SettingsShape,
} from '../../shared/contracts';
import type { RunConfigDraft } from '../chats/run-config';
import {
  isChatApprovalMode,
  newRunConfigId,
  replaceRunConfig,
  targetAgentKind,
} from '../chats/run-config';
import type { TargetWorkflow } from '../chats/target-select';
import { AgentConfigList } from '../components/agent-config-list';
import { ErrorText } from '../components/error-text';
import { ExpandableTextarea } from '../components/expandable-textarea';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Label } from '../components/ui/label';
import { ProgressBar } from '../components/ui/progress-bar';
import { Switch } from '../components/ui/switch';
import { cn } from '../components/ui/utils';
import { createDaemonApis } from '../daemon-api';
import { configDirCapabilityFrom } from '../graphs/use-config-dir-capability';
import { updateStatusText } from '../updates/update-status';
import { useUpdateState } from '../updates/use-update-state';
import { useCapabilities } from '../use-capabilities';
import { useCliLogin } from '../use-cli-login';
import { FastActionsPane } from './fast-actions';
import { useDebouncedPersist } from './use-debounced-persist';

/**
 * One agent-specific switch, drawn inside that agent's card.
 *
 * A local shape rather than a shared component: it is a `Switch`, a `Label`
 * and a note — the same three the page's other sections already compose — and
 * the only thing it adds is that they sit in a card rather than in a section.
 * Promote it the moment a third surface wants the arrangement.
 */
function AgentSetting({
  id,
  checked,
  onCheckedChange,
  label,
  note,
}: {
  id: string;
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  label: string;
  note: string;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-3">
        <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} />
        <Label htmlFor={id} className="cursor-pointer">
          {label}
        </Label>
      </div>
      <p className="text-xs text-muted-foreground">{note}</p>
    </div>
  );
}

/**
 * Whether this instructions value can actually be written to settings.json.
 *
 * `settingsPatchSchema` refuses an over-long value AND one carrying control
 * characters, so attempting either write saves nothing and puts a raw zod
 * string in the error slot. Asked before the debounce is armed, so the two
 * rules cannot drift from what the section's message tells the user.
 */
function savableInstructions(value: string): boolean {
  return (
    value.length <= MAX_CUSTOM_INSTRUCTIONS_CHARS &&
    !hasControlCharacters(value)
  );
}

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
/**
 * Which pane of Settings is on screen.
 *
 * A UNION rather than an index: the sections are named things the app links to
 * (the `+` menu's "Manage fast actions" opens this screen straight at
 * `fast-actions`), and a number would make that link break silently the day a
 * section is inserted above it.
 */
export type SettingsSection = 'general' | 'fast-actions';

/**
 * What a NEW fast action starts from: the choices the composer itself opens
 * on, read straight out of settings.json.
 *
 * Not an approximation of composer state — it IS the state the composer would
 * open with, since those are the same remembered values it seeds from. So a new
 * action is a naming step rather than six pickers, with no coupling between
 * this screen and the chat one.
 *
 * `null` when no folder has ever been chosen: there is nothing to seed from,
 * and the editor's own empty draft asks for a folder outright.
 */
function seedDraftFrom(settings: SettingsShape): RunConfigDraft | null {
  const cwd = settings.projectFolder;
  if (!cwd) {
    return null;
  }
  const target = settings.lastChatTarget ?? 'claude';
  const kind = targetAgentKind(target);
  const approval = settings.lastApprovalMode;
  return {
    name: '',
    firstMessage: null,
    cwd,
    // Deliberately NOT the folder's current branch: a fast action that names
    // one switches to it on every press, and inheriting whatever happened to be
    // checked out would make every action a branch switch nobody asked for.
    branch: null,
    target,
    model: settings.lastModels[kind] ?? null,
    effort: settings.lastEfforts[kind] ?? null,
    contextWindow: settings.lastContextWindows[kind] ?? null,
    modelParameters: settings.lastModelParameters[kind] ?? {},
    // Checked against the enum here for the reason `run-config.ts` records:
    // settings.json is a file the user can edit and an older build can write.
    approval: isChatApprovalMode(approval) ? approval : null,
    configDir: settings.configDir,
  };
}

const SECTION_LABEL: Record<SettingsSection, string> = {
  general: 'General',
  'fast-actions': 'Fast actions',
};

/** Nav order — General first, because it is what Settings has always been. */
const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  'general',
  'fast-actions',
];

export function Settings({
  handle,
  section = 'general',
  onSectionChange,
}: {
  handle: DaemonHandle | null;
  /**
   * The pane to show. Owned by the app shell rather than by this screen so
   * another screen can open Settings AT a section — which is how the composer's
   * "Manage fast actions" reaches the editor in one press.
   */
  section?: SettingsSection;
  onSectionChange?: (next: SettingsSection) => void;
}): React.JSX.Element {
  const apis = useMemo(
    () => (handle ? createDaemonApis(handle) : null),
    [handle],
  );
  const [clis, setClis] = useState<CliDetection[] | null>(null);
  /**
   * The fast actions and everything the editor needs to fill one in — read
   * from settings.json here rather than handed down from Chats, so this screen
   * owns its own data and works whether or not a chat has ever been opened.
   */
  const [runConfigs, setRunConfigs] = useState<RunConfig[]>([]);
  const [recentFolders, setRecentFolders] = useState<string[]>([]);
  const [recentConfigDirs, setRecentConfigDirs] = useState<string[]>([]);
  const [actionSeed, setActionSeed] = useState<RunConfigDraft | null>(null);
  const [workflows, setWorkflows] = useState<TargetWorkflow[]>([]);
  const [open, setOpen] = useState<Partial<Record<CliKind, boolean>>>({});
  const [binaryPaths, setBinaryPaths] = useState<
    Partial<Record<CliKind, string>>
  >({});
  const [checkForUpdates, setCheckForUpdates] = useState(true);
  const [notificationsEnabled, setNotificationsEnabled] = useState(true);
  const [collapseToolSteps, setCollapseToolSteps] = useState(false);
  const [claudeBrowserTools, setClaudeBrowserTools] = useState(false);
  const [cursorMaxMode, setCursorMaxMode] = useState(true);
  const [customInstructions, setCustomInstructions] = useState('');
  const [forgetting, setForgetting] = useState(false);
  /** What the last purge reached, in words — `null` until one has run. */
  const [forgetResult, setForgetResult] = useState<string | null>(null);
  /** Where the on-demand banner got to: idle → testing → what happened. */
  const [notificationTest, setNotificationTest] = useState<
    'idle' | 'testing' | 'shown' | 'unknown'
  >('idle');
  const [notificationTestResult, setNotificationTestResult] = useState<
    string | null
  >(null);
  // The live update state, pushed by main — the same one the app-wide strip
  // reads, so this screen cannot show a stale reading of a running download.
  const update = useUpdateState();
  const updateLine = update.state ? updateStatusText(update.state) : '';
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
    customInstructions: 0,
    other: 0,
  });

  // What the daemon was actually spawned with — the switch must report the
  // port's real state, not the stored `null`.
  const inspectEnabled = resolveDaemonInspect(storedInspect, isPackaged);
  // ONE capabilities read for this whole screen. Two slices are wanted — the
  // host preamble for the instructions preview, and the per-CLI
  // config-directory reasons further down — and `useCapabilities` holds its
  // state per CALL, so asking it twice mounts two fetchers and two retry loops
  // against one endpoint. The config-dir slice goes through the pure selector
  // below rather than through its own hook.
  const capabilities = useCapabilities(apis?.capabilities ?? null);
  // Served by the daemon rather than restated here, so the preview cannot go
  // on describing a preamble the CLIs stopped receiving. Absent until the read
  // lands (and when no daemon is connected) — the honest rendering then is to
  // show nothing, not an empty box captioned as the app's instructions.
  const hostPreamble = capabilities?.hostPreamble;
  const overLimit = customInstructions.length > MAX_CUSTOM_INSTRUCTIONS_CHARS;
  const hasControlChars = hasControlCharacters(customInstructions);

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
      // The instructions field owns its own flush — see `useDebouncedPersist`,
      // which is where the nulled-handle rule that makes it safe now lives.
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
        setCollapseToolSteps(s.collapseToolSteps ?? false);
        setClaudeBrowserTools(s.claudeBrowserTools);
        setCursorMaxMode(s.cursorMaxMode);
      }
      if (!daemonInspectDirtyRef.current) {
        setStoredInspect(s.daemonInspect);
      }
      // Guarded like the others: this read is async, and clobbering the box
      // would discard whatever the user typed while it was in flight.
      if (!instructions.dirtyRef.current) {
        // `?? ''` because this value crosses the IPC boundary and is read for
        // its `.length` on the very next render: an absent key makes the whole
        // Settings screen throw `Cannot read properties of undefined`, not
        // merely render an empty box. `readSettings` merges DEFAULT_SETTINGS
        // so production always carries it — a harness stub or an older main
        // process need not, and losing the screen is far too much to pay for
        // a missing optional field. Same default `Chats.tsx` applies.
        setCustomInstructions(s.customInstructions ?? '');
      }
      setRunConfigs(s.runConfigs ?? []);
      setRecentFolders(s.recentFolders ?? []);
      setRecentConfigDirs(s.recentConfigDirs ?? []);
      setActionSeed(seedDraftFrom(s));
    });
    void window.geniro.getStatus().then((s) => setIsPackaged(s.isPackaged));
    void window.geniro.detectClis().then(setClis);
  }, []);

  const configDirReasonFor = useCallback(
    (kind: CliKind): string | null | undefined =>
      capabilities
        ? capabilities.configDirs.find((row) => row.agent === kind)
            ?.unavailableReason
        : undefined,
    [capabilities],
  );

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
                : patch.customInstructions !== undefined
                  ? 'customInstructions'
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

  // The graphs a fast action can point at. Silent on failure, like every other
  // optional list on this screen: the target chip then offers the CLIs alone,
  // which is a working editor rather than a broken screen.
  useEffect(() => {
    if (!apis) {
      return;
    }
    void apis.workflows
      .listWorkflows()
      .then((list) =>
        setWorkflows(list.map((w) => ({ slug: w.slug, name: w.name }))),
      )
      .catch(() => setWorkflows([]));
  }, [apis]);

  /**
   * Write the whole list, rolling back on refusal.
   *
   * The IPC boundary validates the patch and THROWS on a bad one, so an
   * optimistic write that is not rolled back leaves the screen showing an
   * action settings.json does not have — which the user would find out about
   * on the next launch.
   */
  const persistRunConfigs = useCallback(
    (next: RunConfig[], previous: RunConfig[]): void => {
      setRunConfigs(next);
      setError(null);
      // NOT through `persist`, and that is the whole of why this is written
      // out: `persist` swallows the rejection into `setError`, so a rollback
      // chained onto it could never fire — the screen would keep showing an
      // action settings.json does not have, and every later save would fail on
      // the same entry since the full array is re-sent.
      void window.geniro
        .updateSettings({ runConfigs: next })
        .then(flashSaved)
        .catch((err: unknown) => {
          setRunConfigs(previous);
          setError(String(err));
        });
    },
    [flashSaved],
  );

  const saveRunConfig = useCallback(
    (draft: RunConfigDraft, id: string | null): void => {
      persistRunConfigs(
        id === null
          ? [...runConfigs, { ...draft, id: newRunConfigId() }]
          : replaceRunConfig(runConfigs, { ...draft, id }),
        runConfigs,
      );
    },
    [runConfigs, persistRunConfigs],
  );

  const deleteRunConfig = useCallback(
    (id: string): void => {
      persistRunConfigs(
        runConfigs.filter((c) => c.id !== id),
        runConfigs,
      );
    },
    [runConfigs, persistRunConfigs],
  );

  const approvalModesFor = useCallback(
    (kind: CliKind) =>
      capabilities
        ? (capabilities.approvals.find((row) => row.agent === kind)?.modes ??
          [])
        : null,
    [capabilities],
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

  /**
   * Debounced auto-save of the custom instructions.
   *
   * An unsavable value — over the ceiling, or carrying control characters — is
   * held on screen and never written: `settingsPatchSchema` refuses both, so
   * attempting the write costs a raw zod string in the error slot and saves
   * nothing. The section's own message is what tells the user in words; see
   * {@link overLimit} / {@link hasControlChars} at their render site.
   */
  const instructions = useDebouncedPersist(
    (value: string) => persist({ customInstructions: value }),
    savableInstructions,
  );
  const onCustomInstructionsChange = useCallback(
    (next: string): void => {
      setCustomInstructions(next);
      instructions.schedule(next);
    },
    [instructions],
  );

  /**
   * Drop the instructions every EXISTING chat and workflow run snapshotted.
   *
   * The escape hatch the snapshot design otherwise lacks: clearing the box
   * above changes only the next run, so text a user regrets keeps being sent
   * by every chat opened before the edit. Deliberately a press rather than
   * something clearing the box does on its own — it discards a real guarantee
   * (a chat keeps what it started with), and an edit the user is halfway
   * through must not silently destroy it.
   */
  const forgetExistingInstructions = useCallback(async (): Promise<void> => {
    if (!apis) {
      return;
    }
    setForgetting(true);
    setForgetResult(null);
    setError(null);
    try {
      const { cleared } = await apis.chats.forgetCustomInstructions();
      setForgetResult(
        cleared === 0
          ? 'No existing chat was carrying custom instructions.'
          : `Removed from ${cleared} existing ${cleared === 1 ? 'run' : 'runs'}.`,
      );
    } catch (err) {
      setError(String(err));
    } finally {
      setForgetting(false);
    }
  }, [apis]);

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

  // The pure selector over the single read above — NOT `useConfigDirCapability`,
  // which would fetch the same endpoint a second time from this one screen.
  const configDirCapability = configDirCapabilityFrom(
    capabilities,
    apis !== null,
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

  const onToggleCollapseToolSteps = useCallback(
    (next: boolean): void => {
      setCollapseToolSteps(next);
      // Nothing to restart: the transcript re-reads this whenever the chat tab
      // becomes visible, which is the next thing that happens after leaving
      // this screen.
      void persist({ collapseToolSteps: next });
    },
    [persist],
  );

  /**
   * Post one banner on demand and say what the platform did with it.
   *
   * Four outcomes, kept apart because they need four different things from the
   * user: it showed; the app itself refused (the switch above is off); the
   * system refused (permission, or the app silenced in System Settings); or
   * nothing was reported at all, which is not a failure and must not be
   * announced as one — the banner may be sitting in Notification Centre.
   */
  const onTestNotification = useCallback((): void => {
    setNotificationTest('testing');
    void window.geniro
      .testNotification()
      .then((result) => {
        setNotificationTest(result.shown === true ? 'shown' : 'unknown');
        setNotificationTestResult(
          result.shown === true
            ? 'Sent — you should have seen a banner. If you did not, macOS is holding it: open macOS settings above and switch Geniro on under Notifications.'
            : (result.reason ??
                'Sent, but the system said nothing about it — check Notification Centre.'),
        );
      })
      .catch((err: unknown) => {
        setNotificationTest('unknown');
        setNotificationTestResult(
          err instanceof Error ? err.message : String(err),
        );
      });
  }, []);

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

  const onToggleMaxMode = useCallback(
    (next: boolean): void => {
      setCursorMaxMode(next);
      // Nothing to apply to a running turn: the value is snapshotted onto each
      // run as it is created, and cursor writes it into the throwaway profile
      // it builds per turn. So this reaches the NEXT chat, which is what the
      // note under the switch says.
      void persist({ cursorMaxMode: next });
    },
    [persist],
  );

  const onToggleBrowserTools = useCallback(
    (next: boolean): void => {
      setClaudeBrowserTools(next);
      // Main restarts the daemon on this key: the flag rides the daemon's env
      // and is read when a turn spawns its CLI, so there is nothing to apply to
      // the process already running.
      void persist({ claudeBrowserTools: next });
    },
    [persist],
  );

  return (
    /*
      TWO elements, and the split is the point. REPORTED as "scroll should be
      for all page, not just in the middle": one element was both the centred
      42rem reading column AND the scroll container, so the scrollbar was drawn
      at the column's own right edge — floating inside the pane with dead page
      background either side of it, and nowhere near the window edge every other
      scrollbar on the machine lives at.

      The pane scrolls; the column is what it scrolls. `Stats` was already built
      this way, so this is the house pattern rather than a new one.

      `scrollbar-gutter: stable` because the bar here is a real one that takes
      width — the reporter runs macOS with "always show scrollbars" on, which is
      why it is visible in the screenshot at all — and without the gutter the
      centred column jumps sideways by half its width the moment the content
      grows past one screen.
    */
    // The screen is a NAV COLUMN beside a scrolling pane, and only the pane
    // scrolls — the same split the pane already made internally between the
    // scroll container and the 42rem reading column it scrolls, extended one
    // level out. A nav that scrolled with the content would leave the sections
    // unreachable from the bottom of a long page.
    <div className="flex h-full min-h-0">
      <nav
        aria-label="Settings sections"
        className="flex w-48 shrink-0 flex-col gap-0.5 border-r border-border p-3">
        {SETTINGS_SECTIONS.map((key) => (
          <button
            key={key}
            type="button"
            aria-current={section === key ? 'page' : undefined}
            onClick={() => onSectionChange?.(key)}
            className={cn(
              'w-full rounded-md px-3 py-1.5 text-left text-sm transition-colors',
              section === key
                ? 'bg-sidebar-accent font-medium text-foreground'
                : 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground',
            )}>
            {SECTION_LABEL[key]}
          </button>
        ))}
      </nav>
      <div
        className="h-full min-w-0 flex-1 overflow-y-auto"
        style={{ scrollbarGutter: 'stable' }}>
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-6 py-8">
          <header className="flex flex-col gap-1">
            <div className="flex items-center justify-between">
              <h1 className="text-2xl">{SECTION_LABEL[section]}</h1>
              {savedFlash && !error ? (
                <span className="flex items-center gap-1.5 text-sm text-success">
                  <Check className="size-4" />
                  Saved
                </span>
              ) : null}
            </div>
            <p className="text-sm text-muted-foreground">
              {section === 'fast-actions'
                ? 'Your own buttons on the new-chat screen. Each one carries a folder, a branch, an agent and its options — and, when you give it one, the message it sends the moment you press it.'
                : 'Configure the CLI agents Geniro drives. Changes are saved automatically.'}
            </p>
          </header>

          {section === 'fast-actions' ? (
            <FastActionsPane
              configs={runConfigs}
              agentsApi={apis?.agents ?? null}
              workflows={workflows}
              cliDetections={clis}
              recentFolders={recentFolders}
              recentConfigDirs={recentConfigDirs}
              approvalModesFor={approvalModesFor}
              configDirReasonFor={configDirReasonFor}
              planSupported={capabilities?.claudeModes.plan === 'pass'}
              seed={actionSeed}
              onSave={saveRunConfig}
              onDelete={deleteRunConfig}
            />
          ) : (
            <>
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
                  onSignOut={
                    apis ? (kind) => void signOutFromCli(kind) : undefined
                  }
                  // The press is answered before the daemon replies. That reply is
                  // held until the CLI prints its URL — measured at 4001ms — and the
                  // panel below only appears once it lands, so without this the
                  // button sits unchanged while a browser tab opens behind the
                  // window.
                  signingIn={
                    login.starting?.server === null ? login.starting.kind : null
                  }
                  profileScopedKinds={profileScopedKinds}
                  // Whatever is true of ONE CLI lives on that CLI's card. Both of
                  // these used to be sections of their own further down the page,
                  // which is what got reported: the settings for cursor were half in
                  // the card named cursor and half under a heading named Browser.
                  agentSettings={{
                    claude: (
                      <AgentSetting
                        id="settings-claude-browser-tools"
                        checked={claudeBrowserTools}
                        onCheckedChange={onToggleBrowserTools}
                        label="Let claude drive your browser (Claude in Chrome)"
                        note="Needs Anthropic’s Chrome extension and a browser running it. Off by default: 22 extra tools in every prompt, paid for on each. Flipping this restarts the daemon."
                      />
                    ),
                    'cursor-agent': (
                      <AgentSetting
                        id="settings-cursor-max-mode"
                        checked={cursorMaxMode}
                        onCheckedChange={onToggleMaxMode}
                        label="Max Mode — run models at their largest context window"
                        note="On by default: without it a model with no window of its own runs at 200k where Cursor gives it 1M. Billed at the model’s API rate plus 20% on legacy request-based plans. Applies to new chats."
                      />
                    ),
                  }}
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
                  <Label
                    htmlFor="settings-notifications"
                    className="cursor-pointer">
                    Show system notifications
                  </Label>
                  {/* The one control here that PROVES something rather than sets it.
              macOS asks for permission the first time an app posts and consumes
              that banner to do it, so without a deliberate test the first
              notification anyone should have seen is always the one they never
              get — and every later silence (permission refused, Do Not Disturb,
              the app silenced in System Settings) is indistinguishable from a
              bug in here. */}
                  <div className="ml-auto flex shrink-0 items-center gap-2">
                    {/* Beside the test rather than behind its result, and always
                present: the test says whether the OS is holding the app, and
                this is the only place the user can do anything about it. It
                used to be a SENTENCE naming that place — "System Settings ›
                Notifications › Geniro" — which is the report ("we should have
                some button that will automatically open settings for us"): a
                destination the app knows how to reach, printed as directions
                for the user to follow by hand. */}
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        void window.geniro.openNotificationSettings()
                      }>
                      macOS settings
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={notificationTest === 'testing'}
                      onClick={onTestNotification}>
                      {notificationTest === 'testing'
                        ? 'Sending…'
                        : 'Send a test'}
                    </Button>
                  </div>
                </div>
                {notificationTestResult ? (
                  <p
                    data-slot="notification-test-result"
                    className={cn(
                      'text-xs',
                      notificationTest === 'shown'
                        ? 'text-success'
                        : 'text-muted-foreground',
                    )}>
                    {notificationTestResult}
                  </p>
                ) : null}
                <p className="text-xs text-muted-foreground">
                  Banners when an agent asks something and when a turn ends;
                  clicking one opens that chat. Never for the chat you are
                  watching, or a turn you stopped.
                </p>
              </section>

              <section className="flex flex-col gap-3">
                <h2 className="text-lg font-medium">Transcript</h2>
                <div className="flex items-center gap-3">
                  <Switch
                    id="settings-collapse-tool-steps"
                    checked={collapseToolSteps}
                    onCheckedChange={onToggleCollapseToolSteps}
                  />
                  <Label
                    htmlFor="settings-collapse-tool-steps"
                    className="cursor-pointer">
                    Keep intermediate steps collapsed
                  </Label>
                </div>
                <p className="text-xs text-muted-foreground">
                  A turn's tool calls start folded, file edits included. Every
                  row is still there — one press opens it, and the group header
                  still counts them.
                </p>
              </section>

              <section className="flex flex-col gap-3">
                <h2 className="text-lg font-medium">Custom instructions</h2>
                <ExpandableTextarea
                  id="settings-custom-instructions"
                  title="Custom instructions"
                  value={customInstructions}
                  onChange={onCustomInstructionsChange}
                  rows={6}
                  placeholder="e.g. Always answer in British English. Prefer small, reviewable diffs."
                />
                {/* The note and the button share ONE row. They were two, with the
              second row's only content pushed right by `ml-auto` — which read
              as an orphan the moment the note above it shrank from two
              paragraphs to one, since the button then had nothing to sit
              beside. The errors below get their own full-width line instead of
              competing with the button for this one: "Contains invisible
              control characters — not saved. Pasting from a word processor can
              add them…" does not fit next to anything. */}
                <div className="flex items-start justify-between gap-3">
                  <p className="min-w-0 text-xs text-muted-foreground">
                    Handed to every agent at the start of each new chat or
                    workflow run — one already running keeps what it started
                    with.
                  </p>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="shrink-0"
                    disabled={forgetting || apis === null}
                    onClick={() => void forgetExistingInstructions()}>
                    {forgetting ? 'Removing…' : 'Remove from existing chats'}
                  </Button>
                </div>
                {overLimit ? (
                  <ErrorText>
                    {customInstructions.length.toLocaleString()} /{' '}
                    {MAX_CUSTOM_INSTRUCTIONS_CHARS.toLocaleString()} characters
                    — not saved until you trim it.
                  </ErrorText>
                ) : hasControlChars ? (
                  <ErrorText>
                    Contains invisible control characters — not saved. Pasting
                    from a word processor can add them; retype it or paste as
                    plain text.
                  </ErrorText>
                ) : null}
                {forgetResult ? (
                  <p className="text-xs text-muted-foreground">
                    {forgetResult}
                  </p>
                ) : null}
                {hostPreamble ? (
                  <details data-slot="host-preamble">
                    <summary className="cursor-pointer text-xs text-muted-foreground">
                      Geniro already tells every agent this first
                    </summary>
                    <p className="mt-2 text-xs text-muted-foreground">
                      The CLIs are built for a terminal and say so in their own
                      system prompt, so geniro corrects that before your
                      instructions. You cannot edit it — it describes how this
                      app actually renders a reply.
                    </p>
                    <pre className="mt-2 max-h-64 overflow-auto rounded-md border border-border bg-muted/40 p-3 text-xs whitespace-pre-wrap text-muted-foreground">
                      {hostPreamble}
                    </pre>
                  </details>
                ) : null}
              </section>

              <section className="flex flex-col gap-3">
                <h2 className="text-lg font-medium">Updates</h2>
                <div className="flex items-center gap-3">
                  <Switch
                    id="settings-check-updates"
                    checked={checkForUpdates}
                    onCheckedChange={onToggleUpdates}
                  />
                  <Label
                    htmlFor="settings-check-updates"
                    className="cursor-pointer">
                    Check for updates automatically
                  </Label>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="ml-auto"
                    disabled={updateBusy}
                    onClick={() => void update.check()}>
                    {update.state?.phase === 'checking'
                      ? 'Checking…'
                      : 'Check now'}
                  </Button>
                  {/* The same action as the strip's, on the screen a user opens when
              they went LOOKING for it — not a second mechanism: both call the
              one service, and both are gated on the same `canInstall`. */}
                  {update.state?.phase === 'available' &&
                  update.state.canInstall ? (
                    <Button
                      type="button"
                      variant="default"
                      size="sm"
                      onClick={() => void update.install()}>
                      Update now
                    </Button>
                  ) : null}
                  {/* Installed, waiting on the user. The restart quits the app and
              takes the daemon and every running turn with it, so it is a press
              rather than something that happens the moment the copy ends. */}
                  {update.state?.phase === 'ready' ? (
                    <Button
                      type="button"
                      variant="default"
                      size="sm"
                      onClick={() => void update.relaunch()}>
                      Restart now
                    </Button>
                  ) : null}
                </div>
                <p className="text-xs text-muted-foreground">
                  Checks GitHub Releases on launch and every few minutes.
                  Nothing is installed until you press Update now, and nothing
                  restarts until you press Restart now.
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
                  </p>
                ) : null}
                {/* Only while something is moving: a bar sitting at 0% next to an
            offer would suggest a download nobody started. */}
                {updateWorking && update.state ? (
                  <ProgressBar
                    fraction={
                      update.state.phase === 'installing'
                        ? null
                        : update.state.progress
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
                  <Label
                    htmlFor="settings-daemon-inspect"
                    className="cursor-pointer">
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
                  <code className="rounded bg-muted px-1 py-0.5">
                    chrome://inspect
                  </code>{' '}
                  — this window’s own DevTools (⌥⌘I) cannot. Restarts the
                  daemon, and while the port is open any process on this machine
                  can run code inside it.
                </p>
                {/* The debug drawer lost its title-bar button on request, so this is
              the only place the chord is written down. A line rather than a
              control: putting the drawer back on screen from here would be the
              button again, one nav click further away. */}
                <p className="text-xs text-muted-foreground">
                  ⌥⌘L opens this app’s own debug log — the daemon, agent and UI
                  lines you can copy into a bug report.
                </p>
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
