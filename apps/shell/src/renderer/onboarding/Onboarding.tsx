import { useEffect, useState } from 'react';

import type { CliDetection } from '../../shared/contracts';

export function Onboarding({
  onDone,
}: {
  onDone: () => void;
}): React.JSX.Element {
  const [folder, setFolder] = useState<string | null>(null);
  const [cursorKey, setCursorKey] = useState('');
  const [clis, setClis] = useState<CliDetection[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void window.geniro.detectClis().then(setClis);
  }, []);

  const pickFolder = async (): Promise<void> => {
    const chosen = await window.geniro.pickProjectFolder();
    if (chosen) {
      setFolder(chosen);
    }
  };

  const refreshClis = async (): Promise<void> => {
    setClis(null);
    setClis(await window.geniro.detectClis());
  };

  const finish = async (): Promise<void> => {
    if (!folder) {
      return;
    }
    setBusy(true);
    try {
      await window.geniro.completeOnboarding({
        projectFolder: folder,
        cursorApiKey: cursorKey.trim() || undefined,
      });
      onDone();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="onboarding">
      <h1>Welcome to geniro</h1>
      <p className="muted">
        A local-first studio for teams of CLI coding agents.
      </p>

      <section>
        <h2>1 · Project folder</h2>
        <p className="muted">Where your agents will read and write.</p>
        <div className="row">
          <button onClick={() => void pickFolder()}>Choose folder…</button>
          <code className="path">{folder ?? 'No folder selected'}</code>
        </div>
      </section>

      <section>
        <h2>
          2 · Cursor API key <span className="muted">(optional)</span>
        </h2>
        <p className="muted">
          Stored in your macOS Keychain — never written to disk.
        </p>
        <input
          type="password"
          placeholder="Cursor API key"
          value={cursorKey}
          onChange={(event) => setCursorKey(event.target.value)}
        />
      </section>

      <section>
        <h2>3 · CLI agents</h2>
        <p className="muted">geniro drives these headless.</p>
        <ul className="cli-list">
          {clis === null ? (
            <li className="muted">Detecting…</li>
          ) : (
            clis.map((cli) => (
              <li key={cli.kind} className={cli.found ? 'ok' : 'bad'}>
                <span>
                  {cli.found ? '✓' : '✗'} {cli.kind}
                </span>
                <span className="muted">
                  {cli.found ? (cli.version ?? cli.path) : 'not found on PATH'}
                </span>
              </li>
            ))
          )}
        </ul>
        <button className="link" onClick={() => void refreshClis()}>
          Re-check
        </button>
      </section>

      <footer>
        <button
          className="primary"
          disabled={!folder || busy}
          onClick={() => void finish()}>
          {busy ? 'Finishing…' : 'Get started'}
        </button>
      </footer>
    </div>
  );
}
