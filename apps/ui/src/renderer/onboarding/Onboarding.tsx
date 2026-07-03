import { useEffect, useState } from 'react';

import {
  CLI_KINDS,
  type CliDetection,
  type CliKind,
} from '../../shared/contracts';
import logoUrl from '../assets/logo.png';

/** Collapse/expand affordance; CSS rotates it 180° when its card is open. */
function Chevron(): React.JSX.Element {
  return (
    <svg
      className="agent-chevron"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true">
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
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
    <div className="onboarding">
      <header className="onboarding-head">
        <img className="onboarding-hero" src={logoUrl} alt="geniro" />
        <p className="onboarding-tagline">
          A local-first studio for teams of CLI coding agents.
        </p>
      </header>

      <p className="onboarding-intro muted">
        Set up the CLI agents geniro will drive. You can change this anytime in
        Settings.
      </p>

      {CLI_KINDS.map((kind) => {
        const detection = clis?.find((c) => c.kind === kind) ?? null;
        const isOpen = Boolean(open[kind]);
        const status =
          clis === null
            ? { label: 'Checking…', cls: '' }
            : detection?.found
              ? {
                  label: `detected${detection.version ? ` · ${detection.version}` : ''}`,
                  cls: 'found',
                }
              : { label: 'not found on PATH', cls: 'missing' };
        const pathId = `agent-path-${kind}`;
        return (
          <div key={kind} className={`agent-card${isOpen ? ' open' : ''}`}>
            <button
              className="agent-head"
              aria-expanded={isOpen}
              onClick={() => toggle(kind)}>
              <span className={`agent-dot ${status.cls}`} />
              <span className="agent-title">{kind}</span>
              <span className={`agent-status ${status.cls}`}>
                {status.label}
              </span>
              <Chevron />
            </button>

            {isOpen && (
              <div className="agent-body">
                <div className="field">
                  <label htmlFor={pathId}>Binary path</label>
                  <div className="row">
                    <input
                      id={pathId}
                      className="path-input"
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
                    <button
                      className="btn-choose"
                      onClick={() => void browse(kind)}>
                      Browse…
                    </button>
                  </div>
                  <p className="field-hint">
                    Set only if {kind} isn&apos;t on your PATH.
                  </p>
                </div>

                {kind === 'cursor-agent' ? (
                  <div className="field">
                    <label htmlFor="cursor-api-key">Cursor API key</label>
                    <input
                      id="cursor-api-key"
                      type="password"
                      placeholder="Cursor API key"
                      value={cursorKey}
                      onChange={(event) => setCursorKey(event.target.value)}
                    />
                    <p className="field-hint">
                      Stored in your macOS Keychain — never written to disk.
                    </p>
                  </div>
                ) : (
                  <p className="agent-note">
                    Signs in through the {kind} CLI — no API key needed.
                  </p>
                )}
              </div>
            )}
          </div>
        );
      })}

      <footer className="onboarding-footer">
        {error && <span className="footer-error">{error}</span>}
        <button className="link" onClick={() => void refreshClis()}>
          Re-check
        </button>
        <button
          className="primary"
          disabled={busy}
          onClick={() => void finish()}>
          {busy ? 'Finishing…' : 'Get started'}
        </button>
      </footer>
    </div>
  );
}
