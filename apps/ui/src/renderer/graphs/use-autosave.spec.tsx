// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AUTOSAVE_DELAY_MS,
  useAutosave,
  type UseAutosaveOptions,
  type UseAutosaveResult,
} from './use-autosave';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let latest: UseAutosaveResult;

function Harness(props: UseAutosaveOptions): React.JSX.Element {
  latest = useAutosave(props);
  return <span data-testid="state">{latest.state}</span>;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

/** Mount/update the hook with one set of options. Defaults describe an open
 *  workflow with one unsaved edit — `savedSnapshot: null` must survive as null
 *  (a `??` default would swallow it and silently pass the "no baseline" test). */
function render(
  props: Partial<UseAutosaveOptions> & { save: () => Promise<boolean> },
): void {
  const options: UseAutosaveOptions = {
    enabled: true,
    snapshot: 'v2',
    savedSnapshot: 'v1',
    ...props,
  };
  act(() => {
    root.render(<Harness {...options} />);
  });
}

/** Let the debounce fire and the write's promise settle. */
async function tick(ms = AUTOSAVE_DELAY_MS): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function state(): string {
  return container.querySelector('[data-testid="state"]')!.textContent!;
}

describe('useAutosave', () => {
  it('writes once the debounce elapses — and not before', async () => {
    const save = vi.fn().mockResolvedValue(true);
    render({ save });

    expect(state()).toBe('idle');
    await tick(AUTOSAVE_DELAY_MS - 1);
    expect(save).not.toHaveBeenCalled();

    await tick(1);
    expect(save).toHaveBeenCalledTimes(1);
    expect(state()).toBe('saved');
  });

  it('never writes a canvas that matches what was last saved', async () => {
    const save = vi.fn().mockResolvedValue(true);
    render({ save, snapshot: 'same', savedSnapshot: 'same' });
    await tick();
    expect(save).not.toHaveBeenCalled();
    expect(state()).toBe('idle');
  });

  it('stays silent before a workflow is open (no baseline snapshot)', async () => {
    const save = vi.fn().mockResolvedValue(true);
    render({ save, savedSnapshot: null });
    await tick();
    expect(save).not.toHaveBeenCalled();
  });

  it('writes nothing while disabled — a delete must not be undone by a queued save', async () => {
    const save = vi.fn().mockResolvedValue(true);
    render({ save, enabled: false });
    await tick();
    expect(save).not.toHaveBeenCalled();
  });

  it('restarts the debounce on each edit, so typing is ONE write', async () => {
    const save = vi.fn().mockResolvedValue(true);
    render({ save, snapshot: 'k1' });
    await tick(AUTOSAVE_DELAY_MS - 50);
    render({ save, snapshot: 'k2' });
    await tick(AUTOSAVE_DELAY_MS - 50);
    render({ save, snapshot: 'k3' });
    // Two near-misses so far: neither keystroke got to write.
    expect(save).not.toHaveBeenCalled();

    await tick();
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('re-arms for edits that landed DURING a write', async () => {
    const save = vi.fn().mockResolvedValue(true);
    render({ save, snapshot: 'v2', savedSnapshot: 'v1' });
    await tick();
    expect(save).toHaveBeenCalledTimes(1);

    // The write persisted v2, but the user has since typed v3.
    render({ save, snapshot: 'v3', savedSnapshot: 'v2' });
    await tick();
    expect(save).toHaveBeenCalledTimes(2);
  });

  it('reports a rejected write as failed rather than claiming Saved', async () => {
    // The defensive catch: `persist` swallows its own errors, but nothing in
    // the type system stops a future save impl from rejecting.
    const save = vi.fn().mockRejectedValue(new Error('daemon down'));
    render({ save });
    await tick();
    expect(state()).toBe('failed');
  });

  it('reports a false result as failed', async () => {
    const save = vi.fn().mockResolvedValue(false);
    render({ save });
    await tick();
    expect(state()).toBe('failed');
  });

  it('flush writes immediately, without waiting out the debounce', async () => {
    const save = vi.fn().mockResolvedValue(true);
    render({ save });
    await act(async () => {
      await latest.flush();
    });
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('flush on a clean canvas writes nothing', async () => {
    const save = vi.fn().mockResolvedValue(true);
    render({ save, snapshot: 'same', savedSnapshot: 'same' });
    await act(async () => {
      await latest.flush();
    });
    expect(save).not.toHaveBeenCalled();
  });

  it('never runs two writes at once (flush during an in-flight write)', async () => {
    let release: (ok: boolean) => void = () => {};
    const save = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve;
        }),
    );
    render({ save });

    // Debounced write starts and hangs.
    await tick();
    expect(save).toHaveBeenCalledTimes(1);
    expect(state()).toBe('saving');

    // Leaving the builder mid-write must not fire a second overlapping write.
    await act(async () => {
      void latest.flush();
    });
    expect(save).toHaveBeenCalledTimes(1);

    await act(async () => {
      release(true);
    });
    expect(state()).toBe('saved');
  });
});
