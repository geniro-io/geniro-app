import { Check } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  CLI_KINDS,
  type CliDetection,
  type CliKind,
  type Settings as SettingsShape,
} from '../../shared/contracts';
import { AgentConfigList } from '../components/agent-config-list';
import { ErrorText } from '../components/error-text';
import { Button } from '../components/ui/button';
import { Label } from '../components/ui/label';
import { Switch } from '../components/ui/switch';

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
 * (`AgentConfigList`) so binary paths and the Cursor key are edited the same way
 * everywhere. Everything is saved automatically — no Save button: the update
 * toggle persists on flip, binary-path edits persist debounced, and the Cursor
 * key (Keychain) persists on blur. Persists via updateSettings (paths) and the
 * Keychain (Cursor key) — never `completeOnboarding`, which is first-run only.
 */
export function Settings(): React.JSX.Element {
  const [clis, setClis] = useState<CliDetection[] | null>(null);
  const [open, setOpen] = useState<Partial<Record<CliKind, boolean>>>({});
  const [binaryPaths, setBinaryPaths] = useState<
    Partial<Record<CliKind, string>>
  >({});
  const [cursorKey, setCursorKey] = useState('');
  const [hasStoredKey, setHasStoredKey] = useState<boolean | null>(null);
  const [checkForUpdates, setCheckForUpdates] = useState(true);
  const [updateStatus, setUpdateStatus] = useState<string | null>(null);
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);
  const checkForUpdatesDirtyRef = useRef(false);
  const persistGenerationRef = useRef({
    cliPaths: 0,
    checkForUpdates: 0,
    other: 0,
  });

  const keyPresent = (hasStoredKey ?? false) || cursorKey.trim() !== '';

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
    });
    void window.geniro.detectClis().then(setClis);
    void window.geniro.hasSecret('cursor.apiKey').then(setHasStoredKey);
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

  const saveCursorKey = useCallback(async (): Promise<void> => {
    const trimmed = cursorKey.trim();
    if (!trimmed) {
      return;
    }
    setError(null);
    try {
      await window.geniro.saveSecret('cursor.apiKey', trimmed);
      setHasStoredKey(true);
      setCursorKey('');
      flashSaved();
    } catch (err) {
      setError(String(err));
    }
  }, [cursorKey, flashSaved]);

  const removeKey = useCallback(async (): Promise<void> => {
    setError(null);
    // Mirror saveCursorKey: the IPC call also restarts the daemon, which has
    // real failure paths — a silent unhandled rejection would leave the UI
    // claiming the key is gone with zero feedback.
    try {
      await window.geniro.deleteSecret('cursor.apiKey');
      setHasStoredKey(false);
      setCursorKey('');
      flashSaved();
    } catch (err) {
      setError(String(err));
    }
  }, [flashSaved]);

  const onToggleUpdates = useCallback(
    (next: boolean): void => {
      checkForUpdatesDirtyRef.current = true;
      setCheckForUpdates(next);
      void persist({ checkForUpdates: next });
    },
    [persist],
  );

  const checkNow = useCallback(async (): Promise<void> => {
    setCheckingUpdates(true);
    setUpdateStatus(null);
    try {
      const result = await window.geniro.checkForUpdates();
      setUpdateStatus(
        result.status === 'up-to-date'
          ? `Up to date (v${result.version ?? '?'})`
          : // 'available' / 'dev' / 'error' all carry a ready-to-show message
            // (for 'available' it names the brew/script update command).
            (result.message ?? result.status),
      );
    } catch (err) {
      setUpdateStatus(String(err));
    } finally {
      setCheckingUpdates(false);
    }
  }, []);

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

      {error ? <ErrorText>{error}</ErrorText> : null}

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
          keyPresent={keyPresent}
          cursorKey={cursorKey}
          onCursorKeyChange={setCursorKey}
          onCursorKeyBlur={() => void saveCursorKey()}
          hasStoredKey={hasStoredKey}
          onRemoveKey={() => void removeKey()}
        />
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
            Check for app updates on launch
          </Label>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="ml-auto"
            disabled={checkingUpdates}
            onClick={() => void checkNow()}>
            {checkingUpdates ? 'Checking…' : 'Check now'}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Geniro notifies you of a new release but does not self-update —
          install updates with{' '}
          <code className="rounded bg-muted px-1 py-0.5">
            brew upgrade --cask geniro
          </code>{' '}
          or by re-running the install script.
        </p>
        {updateStatus ? (
          <p className="text-xs text-muted-foreground">{updateStatus}</p>
        ) : null}
      </section>
    </div>
  );
}
