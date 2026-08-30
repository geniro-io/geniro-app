import './styles/global.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import { ErrorBoundary } from './components/error-boundary';
import { initTheme, setThemePreference } from './theme/apply-theme';

// Before `createRoot`, so `<html data-theme>` is set for the FIRST paint —
// after it, a dark-theme window shows one frame of the light palette.
initTheme();
// And then the exact answer, once it can be read. Only a theme whose name is
// neither `light` nor `dark` can differ from what `initTheme` already resolved
// (see `apply-theme.ts`), so this is a correction that normally corrects
// nothing rather than a second source of truth.
void window.geniro
  .getSettings()
  .then((settings) => setThemePreference(settings.theme))
  .catch((err: unknown) => {
    console.error('failed to read the stored theme preference', err);
  });

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(
    <StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </StrictMode>,
  );
}
