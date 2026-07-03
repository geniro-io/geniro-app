import { useEffect, useRef, useState } from 'react';

import {
  CLI_KINDS,
  type CliDetection,
  type CliKind,
} from '../../shared/contracts';
import { CollapsibleCard } from '../components/collapsible-card';
import { ErrorText } from '../components/error-text';
import { Field } from '../components/field';
import { Logo } from '../components/logo';
import { NoteBox } from '../components/note-box';
import { StatusDot, type StatusTone } from '../components/status-dot';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';

type AgentStatus = { label: string; tone: StatusTone };

/** Agents that can't run on the binary alone — they also need a saved secret. */
function needsApiKey(kind: CliKind): boolean {
  return kind === 'cursor-agent';
}

/**
 * Readiness of one agent. "Ready" (green) means the app can actually drive it:
 * the binary was detected AND, for key-gated agents, a key is present. A
 * detected-but-keyless cursor-agent is amber, not green — it can't run yet.
 */
function statusFor(
  clis: CliDetection[] | null,
  kind: CliKind,
  keyPresent: boolean,
): AgentStatus {
  if (clis === null) {
    return { label: 'Checking…', tone: 'unknown' };
  }
  const detection = clis.find((c) => c.kind === kind) ?? null;
  if (!detection?.found) {
    return { label: 'not found on PATH', tone: 'bad' };
  }
  const version = detection.version ? ` · ${detection.version}` : '';
  if (needsApiKey(kind) && !keyPresent) {
    return { label: `detected${version} · needs API key`, tone: 'warn' };
  }
  return { label: `ready${version}`, tone: 'ok' };
}

const STATUS_TEXT: Record<StatusTone, string> = {
  ok: 'text-sm text-success',
  warn: 'text-sm text-warning',
  bad: 'text-sm text-destructive',
  unknown: 'text-sm text-muted-foreground',
};

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

      <div className="flex flex-col gap-3">
        {CLI_KINDS.map((kind) => {
          const detection = clis?.find((c) => c.kind === kind) ?? null;
          const status = statusFor(clis, kind, keyPresent);
          const isOpen = Boolean(open[kind]);
          const pathId = `agent-path-${kind}`;
          const found = Boolean(detection?.found);
          return (
            <CollapsibleCard
              key={kind}
              open={isOpen}
              onToggle={() => toggle(kind)}
              header={
                <>
                  <StatusDot tone={status.tone} />
                  <span className="font-medium">{kind}</span>
                  <span className={STATUS_TEXT[status.tone]}>
                    {status.label}
                  </span>
                </>
              }>
              <Field
                label="Binary path"
                htmlFor={pathId}
                hint={
                  found
                    ? 'Detected here — edit to pin a different binary.'
                    : `Set the full path to the ${kind} binary.`
                }>
                <div className="flex gap-2">
                  <Input
                    id={pathId}
                    type="text"
                    placeholder="Auto-detect on PATH"
                    value={binaryPaths[kind] ?? ''}
                    onChange={(event) =>
                      setBinaryPaths((prev) => ({
                        ...prev,
                        [kind]: event.target.value,
                      }))
                    }
                  />
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => void browse(kind)}>
                    Browse…
                  </Button>
                </div>
              </Field>

              {needsApiKey(kind) ? (
                <Field
                  label="Cursor API key"
                  htmlFor="cursor-api-key"
                  hint={
                    hasStoredKey
                      ? 'A key is already saved in your Keychain — enter a new one to replace it.'
                      : 'Required to run cursor-agent. Stored in your macOS Keychain — never written to disk.'
                  }>
                  <Input
                    id="cursor-api-key"
                    type="password"
                    placeholder={
                      hasStoredKey
                        ? 'Saved — enter a new key to replace'
                        : 'Cursor API key'
                    }
                    value={cursorKey}
                    onChange={(event) => setCursorKey(event.target.value)}
                  />
                </Field>
              ) : (
                <NoteBox>
                  Signs in through the {kind} CLI — no API key needed.
                </NoteBox>
              )}
            </CollapsibleCard>
          );
        })}
      </div>

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
