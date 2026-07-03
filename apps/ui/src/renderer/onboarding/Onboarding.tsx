import { useEffect, useRef, useState } from 'react';

import {
  CLI_KINDS,
  type CliDetection,
  type CliKind,
} from '../../shared/contracts';
import { AgentConfigList, statusFor } from '../components/agent-config-list';
import { ErrorText } from '../components/error-text';
import { Logo } from '../components/logo';
import { Button } from '../components/ui/button';

export function Onboarding({
  onDone,
}: {
  onDone: () => void;
}): React.JSX.Element {
  const [clis, setClis] = useState<CliDetection[] | null>(null);
  const [open, setOpen] = useState<Partial<Record<CliKind, boolean>>>({});
  const [binaryPaths, setBinaryPaths] = useState<
    Partial<Record<CliKind, string>>
  >({});
  const [cursorKey, setCursorKey] = useState('');
  // Whether a Cursor key is already saved in the Keychain (null = still loading).
  const [hasStoredKey, setHasStoredKey] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const didAutoOpenRef = useRef(false);

  const keyPresent = (hasStoredKey ?? false) || cursorKey.trim() !== '';

  useEffect(() => {
    void window.geniro.detectClis().then(setClis);
    void window.geniro.hasSecret('cursor.apiKey').then(setHasStoredKey);
  }, []);

  // Pre-fill each detected binary's resolved path into its (empty) field, so a
  // found agent shows exactly which binary will be used. Seeding only empty
  // fields never clobbers a path the user typed, and a re-check backfills any
  // field still blank.
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

  // Once, after the first detection + key probe settle, expand every agent that
  // isn't ready — so the thing the user must fix (a missing binary path, a
  // missing Cursor key) is visible without hunting for the disclosure.
  useEffect(() => {
    if (didAutoOpenRef.current || clis === null || hasStoredKey === null) {
      return;
    }
    didAutoOpenRef.current = true;
    const auto: Partial<Record<CliKind, boolean>> = {};
    for (const kind of CLI_KINDS) {
      if (statusFor(clis, kind, keyPresent).tone !== 'ok') {
        auto[kind] = true;
      }
    }
    setOpen((prev) => ({ ...auto, ...prev }));
  }, [clis, hasStoredKey, keyPresent]);

  const refreshClis = async (): Promise<void> => {
    setClis(null);
    setClis(await window.geniro.detectClis());
  };

  const toggle = (kind: CliKind): void => {
    setOpen((prev) => ({ ...prev, [kind]: !prev[kind] }));
  };

  const browse = async (kind: CliKind): Promise<void> => {
    const chosen = await window.geniro.pickAgentBinary();
    if (chosen) {
      setBinaryPaths((prev) => ({ ...prev, [kind]: chosen }));
    }
  };

  const finish = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const cliPaths: Partial<Record<CliKind, string>> = {};
      for (const kind of CLI_KINDS) {
        const path = binaryPaths[kind]?.trim();
        if (path) {
          cliPaths[kind] = path;
        }
      }
      await window.geniro.completeOnboarding({
        cliPaths,
        cursorApiKey: cursorKey.trim() || undefined,
      });
      onDone();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto flex h-full w-full max-w-xl flex-col gap-6 overflow-y-auto px-6 py-10">
      <header className="flex flex-col items-center gap-3 text-center">
        <Logo size="hero" />
        <p className="text-muted-foreground">
          A local-first studio for teams of CLI coding agents.
        </p>
      </header>

      <p className="text-sm text-muted-foreground">
        Set up the CLI agents Geniro will drive. You can change this anytime in
        Settings.
      </p>

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
      />

      <footer className="mt-auto flex items-center gap-3 pt-2">
        {error ? <ErrorText className="mr-auto">{error}</ErrorText> : null}
        <Button
          type="button"
          variant="ghost"
          className={error ? '' : 'ml-auto'}
          onClick={() => void refreshClis()}>
          Re-check
        </Button>
        <Button type="button" disabled={busy} onClick={() => void finish()}>
          {busy ? 'Finishing…' : 'Get started'}
        </Button>
      </footer>
    </div>
  );
}
