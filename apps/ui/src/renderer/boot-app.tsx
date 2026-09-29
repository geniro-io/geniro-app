import { type ComponentType, StrictMode } from 'react';
import type { Root } from 'react-dom/client';

import { ErrorBoundary } from './components/error-boundary';

/** Rethrows during render, so a failure from BEFORE React is caught by the boundary like any other. */
function RenderFailure({ error }: { error: unknown }): never {
  throw error instanceof Error ? error : new Error(String(error));
}

/**
 * Load the app's own chunk and render it — or, when that chunk cannot be
 * loaded, render the failure through the root `ErrorBoundary`.
 *
 * The app is imported DYNAMICALLY (see `main.tsx`), so it is a chunk like any
 * lazy view and can go missing the same way: a page kept across an update
 * asks for the old build's file. With nothing catching the import, that left
 * a blank window with the reason in a console nobody can open on a phone.
 * Routing it through the boundary gives it the same one reload for a stale
 * bundle, and the same visible error otherwise.
 */
export async function renderLoadedApp(
  root: Root,
  load: () => Promise<{ App: ComponentType }>,
  /** Test seam only — how a stale bundle is reloaded. */
  reload?: () => void,
): Promise<void> {
  try {
    const { App } = await load();
    root.render(
      <StrictMode>
        <ErrorBoundary reload={reload}>
          <App />
        </ErrorBoundary>
      </StrictMode>,
    );
  } catch (error) {
    root.render(
      <StrictMode>
        <ErrorBoundary reload={reload}>
          <RenderFailure error={error} />
        </ErrorBoundary>
      </StrictMode>,
    );
  }
}
