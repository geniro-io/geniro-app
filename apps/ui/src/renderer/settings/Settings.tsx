import { Check } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import {
  CLI_KINDS,
  type CliDetection,
  type CliKind,
} from '../../shared/contracts';
import { AgentConfigList } from '../components/agent-config-list';
import { ErrorText } from '../components/error-text';
import { Button } from '../components/ui/button';

/**
 * Post-onboarding configuration. Reuses the onboarding agent-config UI
 * (`AgentConfigList`) so binary paths and the Cursor key are edited the same way
 * everywhere. Persists via updateSettings (paths) and the Keychain (Cursor key)
 * — never `completeOnboarding`, which is a first-run-only transition.
 */
export function Settings(): React.JSX.Element {
  const [clis, setClis] = useState<CliDetection[] | null>(null);
  const [open, setOpen] = useState<Partial<Record<CliKind, boolean>>>({});
  const [binaryPaths, setBinaryPaths] = useState<
    Partial<Record<CliKind, string>>
  >({});
  const [cursorKey, setCursorKey] = useState('');
  const [hasStoredKey, setHasStoredKey] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const keyPresent = (hasStoredKey ?? false) || cursorKey.trim() !== '';

  useEffect(() => {
    void window.geniro.getSettings().then((s) => {
      // Seed saved overrides; the detection effect backfills the rest.
      setBinaryPaths((prev) => ({ ...s.cliPaths, ...prev }));
    });
    void window.geniro.detectClis().then(setClis);
    void window.geniro.hasSecret('cursor.apiKey').then(setHasStoredKey);
  }, []);

  // Pre-fill each detected binary's resolved path into its (empty) field, so a
  // found agent shows exactly which binary will be used. Never clobbers a saved
  // override or a value the user typed.
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

  const toggle = useCallback((kind: CliKind): void => {
    setOpen((prev) => ({ ...prev, [kind]: !prev[kind] }));
  }, []);

  const refreshClis = useCallback(async (): Promise<void> => {
    setClis(null);
    setClis(await window.geniro.detectClis());
  }, []);

  const browse = useCallback(async (kind: CliKind): Promise<void> => {
    const chosen = await window.geniro.pickAgentBinary();
    if (chosen) {
      setBinaryPaths((prev) => ({ ...prev, [kind]: chosen }));
    }
  }, []);

  const removeKey = useCallback(async (): Promise<void> => {
    await window.geniro.deleteSecret('cursor.apiKey');
    setHasStoredKey(false);
    setCursorKey('');
  }, []);

  const save = useCallback(async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const trimmedKey = cursorKey.trim();
      if (trimmedKey) {
        await window.geniro.saveSecret('cursor.apiKey', trimmedKey);
        setHasStoredKey(true);
        setCursorKey('');
      }
      const cliPaths: Partial<Record<CliKind, string>> = {};
      for (const kind of CLI_KINDS) {
        const path = binaryPaths[kind]?.trim();
        if (path) {
          cliPaths[kind] = path;
        }
      }
      await window.geniro.updateSettings({ cliPaths });
      setSaved(true);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }, [cursorKey, binaryPaths]);

  return (
    <div className="mx-auto flex h-full w-full max-w-2xl flex-col gap-6 overflow-y-auto px-6 py-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Configure the CLI agents Geniro drives.
        </p>
      </header>

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
          onBinaryPathChange={(kind, value) =>
            setBinaryPaths((prev) => ({ ...prev, [kind]: value }))
          }
          onBrowse={(kind) => void browse(kind)}
          keyPresent={keyPresent}
          cursorKey={cursorKey}
          onCursorKeyChange={setCursorKey}
          hasStoredKey={hasStoredKey}
          onRemoveKey={() => void removeKey()}
        />
      </section>

      <footer className="mt-auto flex items-center gap-3 border-t border-border pt-4">
        {error ? <ErrorText className="mr-auto">{error}</ErrorText> : null}
        {saved && !error ? (
          <span className="mr-auto flex items-center gap-1.5 text-sm text-success">
            <Check className="size-4" />
            Saved
          </span>
        ) : null}
        <Button
          type="button"
          className={error || saved ? '' : 'ml-auto'}
          disabled={busy}
          onClick={() => void save()}>
          {busy ? 'Saving…' : 'Save changes'}
        </Button>
      </footer>
    </div>
  );
}
