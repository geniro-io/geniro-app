import { useEffect, useState } from 'react';

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

function agentStatus(clis: CliDetection[] | null, kind: CliKind): AgentStatus {
  if (clis === null) {
    return { label: 'Checking…', tone: 'unknown' };
  }
  const detection = clis.find((c) => c.kind === kind) ?? null;
  if (detection?.found) {
    return {
      label: `detected${detection.version ? ` · ${detection.version}` : ''}`,
      tone: 'ok',
    };
  }
  return { label: 'not found on PATH', tone: 'bad' };
}

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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void window.geniro.detectClis().then(setClis);
  }, []);

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
          const status = agentStatus(clis, kind);
          const isOpen = Boolean(open[kind]);
          const pathId = `agent-path-${kind}`;
          return (
            <CollapsibleCard
              key={kind}
              open={isOpen}
              onToggle={() => toggle(kind)}
              header={
                <>
                  <StatusDot tone={status.tone} />
                  <span className="font-medium">{kind}</span>
                  <span
                    className={
                      status.tone === 'ok'
                        ? 'text-sm text-success'
                        : status.tone === 'bad'
                          ? 'text-sm text-destructive'
                          : 'text-sm text-muted-foreground'
                    }>
                    {status.label}
                  </span>
                </>
              }>
              <Field
                label="Binary path"
                htmlFor={pathId}
                hint={`Set only if ${kind} isn't on your PATH.`}>
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

              {kind === 'cursor-agent' ? (
                <Field
                  label="Cursor API key"
                  htmlFor="cursor-api-key"
                  hint="Stored in your macOS Keychain — never written to disk.">
                  <Input
                    id="cursor-api-key"
                    type="password"
                    placeholder="Cursor API key"
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
