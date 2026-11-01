// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { StartupScreen } from './startup-screen';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function render(props: React.ComponentProps<typeof StartupScreen>): string {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(<StartupScreen {...props} />));
  return container.textContent ?? '';
}

describe('StartupScreen', () => {
  it('says the data is being updated, with the step, while the engine migrates', () => {
    const text = render({
      since: Date.now(),
      migrating: { id: '0002-rename', step: 1, of: 2 },
    });

    expect(text).toContain('Updating your data…');
    expect(text).toContain('Step 1 of 2');
    expect(text).not.toContain('Starting Geniro');
  });

  it('names no step count for a migration of one step', () => {
    const text = render({
      since: Date.now(),
      migrating: { id: '0002-rename', step: 1, of: 1 },
    });

    expect(text).toContain('Updating your data…');
    expect(text).toContain('Bringing your data up to this version');
    expect(text).not.toContain('Step 1 of 1');
  });

  it('says it is starting on an ordinary start', () => {
    const text = render({ since: Date.now() });

    expect(text).toContain('Starting Geniro');
    expect(text).not.toContain('Updating your data');
  });

  it('shows the failure, not the migration, once the start failed', () => {
    const text = render({
      since: Date.now(),
      migrating: { id: '0002-rename', step: 1, of: 1 },
      reason: 'updating your data failed at 0002-rename',
    });

    expect(text).toContain('The local engine didn’t start');
    expect(text).not.toContain('Updating your data…');
  });
});
