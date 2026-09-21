import './styles/global.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { ErrorBoundary } from './components/error-boundary';
import { PairingScreen } from './components/pairing-screen';
import { installRemoteBridge } from './remote/install-remote-bridge';
import { isRemoteRuntime, readSession } from './remote/remote-session';
import { initTheme, setThemePreference } from './theme/apply-theme';

/**
 * FIRST statement, ahead of everything that could read `window.geniro` —
 * including `./App`, which is deliberately imported DYNAMICALLY inside
 * `renderApp` below rather than statically up here.
 *
 * That split is load-bearing, not stylistic. A static `import { App } from
 * './App'` is not source-order dependent the way a plain statement is: every
 * module in the static dependency graph is linked and fully evaluated before
 * ANY of this module's own top-level statements run, wherever those
 * statements sit relative to the import declarations — so a call merely
 * written "first" among static imports would still lose the race against
 * `./App`. The job here is a function CALL (`installRemoteBridge()`), which
 * has no hook into import evaluation order the way a side-effect import
 * does — so the only genuine fix is deferring the one import that could read
 * the bridge until after this line has already run, via a dynamic
 * `import('./App')`.
 */
installRemoteBridge();

// Before `createRoot`, so `<html data-theme>` is set for the FIRST paint —
// after it, a dark-theme window shows one frame of the light palette.
initTheme();
/**
 * And then the exact answer, once it can be read. Only a theme whose name is
 * neither `light` nor `dark` can differ from what `initTheme` already
 * resolved (see `apply-theme.ts`), so this is a correction that normally
 * corrects nothing rather than a second source of truth.
 *
 * Deferred until the app is actually rendered, because in a BROWSER this is a
 * bridge call and the bridge refuses an unpaired caller: fired at module
 * scope it was the first thing every fresh device did, and it answered 401
 * and logged a failure under the pairing screen before the user had typed
 * anything.
 */
function applyStoredTheme(): void {
  void window.geniro
    .getSettings()
    .then((settings) => setThemePreference(settings.theme))
    .catch((err: unknown) => {
      console.error('failed to read the stored theme preference', err);
    });
}

const container = document.getElementById('root');

if (container) {
  // ONE root for the life of the window, so the pairing screen's success
  // handler can hand off to the real app by re-rendering the SAME root
  // rather than calling `createRoot` a second time on a container React has
  // already mounted into (which React itself warns is a mistake).
  const root = createRoot(container);

  function renderApp(): void {
    applyStoredTheme();
    // Destructured in the BODY rather than the parameter list: naming
    // convention requires a `parameter` to be camelCase, and `App` has to
    // stay capitalized to render as a component rather than a literal
    // `<App>` DOM tag — a `variable` binding is where PascalCase is allowed.
    void import('./App').then((mod) => {
      const { App } = mod;
      root.render(
        <StrictMode>
          <ErrorBoundary>
            <App />
          </ErrorBoundary>
        </StrictMode>,
      );
    });
  }

  if (isRemoteRuntime()) {
    // A phone's browser has no preload bridge and therefore no daemon
    // token either — it has to ask the gateway whether this browser was
    // already let in before it can show anything else.
    void readSession().then((session) => {
      if (session.paired) {
        renderApp();
        return;
      }
      root.render(
        <StrictMode>
          <ErrorBoundary>
            <PairingScreen onPaired={renderApp} />
          </ErrorBoundary>
        </StrictMode>,
      );
    });
  } else {
    renderApp();
  }
}
