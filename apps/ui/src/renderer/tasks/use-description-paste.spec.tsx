// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createPreloadStub } from '../__fixtures__/preload-stub';
import type { DaemonApis } from '../daemon-api';
import { useDescriptionPaste } from './use-description-paste';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let pasteField: HTMLTextAreaElement | null = null;

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  pasteField?.remove();
  root = null;
  container = null;
  pasteField = null;
  vi.restoreAllMocks();
});

/** A clipboard carrying one file, as a paste event's `clipboardData`. */
function clipboard(file: File | null): DataTransfer {
  return {
    files: file === null ? [] : [file],
    types: file === null ? [] : ['Files'],
  } as unknown as DataTransfer;
}

const png = (name = 'shot.png'): File =>
  new File([new Uint8Array([1, 2, 3])], name, { type: 'image/png' });

interface Harness {
  paste: (data: DataTransfer) => { defaultPrevented: boolean };
  state: () => { error: string | null; uploading: boolean };
}

function mount(tasksApi: DaemonApis['tasks'] | null): Harness {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  let latest: ReturnType<typeof useDescriptionPaste> | null = null;
  function Probe(): null {
    latest = useDescriptionPaste({ taskId: 't1', tasksApi });
    return null;
  }
  act(() => {
    root!.render(<Probe />);
  });
  // A real, focusable element standing in for the field the paste landed on —
  // `document.activeElement` is what the fix reads back once the upload
  // lands. Appended AFTER the render: React's own mount into `container`
  // would otherwise carry it away.
  const field = document.createElement('textarea');
  document.body.appendChild(field);
  pasteField = field;
  return {
    paste: (data) => {
      field.focus();
      let prevented = false;
      const event = {
        clipboardData: data,
        currentTarget: field,
        preventDefault: () => {
          prevented = true;
        },
      } as unknown as React.ClipboardEvent<HTMLTextAreaElement>;
      act(() => {
        latest!.onPaste(event);
      });
      return { defaultPrevented: prevented };
    },
    state: () => ({
      error: latest!.error,
      uploading: latest!.uploading,
    }),
  };
}

/**
 * Let a `FileReader` and the round trip behind it finish.
 *
 * The read is a TASK, not a microtask, so flushing promises is not enough —
 * a spec that only awaited `Promise.resolve()` asserted before the upload had
 * been asked for at all, and read as the hook doing nothing.
 */
/**
 * jsdom implements neither `DataTransfer` nor `document.execCommand`, so the
 * insertion has to be installed rather than spied on — `vi.spyOn` refuses a
 * property that does not exist.
 */
function stubExecCommand(returns: boolean): ReturnType<typeof vi.fn> {
  const exec = vi.fn(() => returns);
  document.execCommand = exec as unknown as typeof document.execCommand;
  return exec;
}

/** Bounded so a genuinely stuck chain FAILS rather than hanging the suite. */
const MAX_SETTLE_TURNS = 50;

/** One macrotask turn, with React's own work flushed around it. */
const turn = async (): Promise<void> => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

/**
 * Drain the paste chain.
 *
 * `readAsBase64` is a `FileReader`, and its `onload` is an EVENT rather than a
 * microtask, so the number of turns before the two promise hops behind it
 * resolve is NOT fixed. This was a pair of `setTimeout(0)`s, which is enough
 * almost always and not always: measured as one failure in six full-suite runs,
 * where a loaded parallel worker pushed the FileReader event past both timers
 * and left `error` still null at the assertion — a flake in the test's timing
 * assumption, not in the hook.
 *
 * Every caller passes the CONDITION it is waiting for and this polls until it
 * holds. Raising the fixed count instead would only have made the flake rarer,
 * which is the thing the no-flaky-tests rule calls retrying around the problem.
 */
const settle = async (done: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < MAX_SETTLE_TURNS; attempt += 1) {
    await turn();
    if (done()) {
      return;
    }
  }
  throw new Error(
    `the paste chain did not settle within ${MAX_SETTLE_TURNS} turns`,
  );
};

/**
 * Pasting a screenshot into a task description.
 *
 * REPORTED as "я всё ещё не могу вставлять файлы или изображения… Сейчас
 * ничего не происходит" — nothing was listening at all.
 */
describe('useDescriptionPaste', () => {
  it('swallows an image paste BEFORE the upload, not after', async () => {
    // The browser's default paste of an image file inserts its NAME, so a
    // `preventDefault` that waited for the round trip would leave
    // `shot.png` sitting in the description beside the reference.
    const addTaskAttachment = vi.fn(() => new Promise(() => {}));
    const api = { addTaskAttachment } as unknown as DaemonApis['tasks'];
    const harness = mount(api);

    const result = harness.paste(clipboard(png()));

    // Synchronous, and that is the whole assertion: the upload itself is a
    // round trip behind a `FileReader`, which is a TASK rather than a
    // microtask — so a `preventDefault` waiting on it would land a frame after
    // the browser had already pasted the name.
    expect(result.defaultPrevented).toBe(true);
    expect(addTaskAttachment).not.toHaveBeenCalled();
    // The chain deliberately never settles here (the api returns a promise that
    // never resolves), so the dispatched call is the condition to wait on.
    await settle(() => addTaskAttachment.mock.calls.length > 0);
    expect(addTaskAttachment).toHaveBeenCalledTimes(1);
  });

  it('writes a markdown reference to the PATH the daemon answered with', async () => {
    // A path and never an inline `data:` URL: the description is a brief an
    // AGENT works from, and an agent cannot open a base64 blob.
    const exec = stubExecCommand(true);
    const api = {
      addTaskAttachment: vi.fn().mockResolvedValue({
        path: '/u/task-attachments/t1/a.png',
        name: 'Pasted image',
      }),
    } as unknown as DaemonApis['tasks'];
    const harness = mount(api);

    harness.paste(clipboard(png()));
    await settle(() => !harness.state().uploading);

    expect(exec).toHaveBeenCalledWith(
      'insertText',
      false,
      '![Pasted image](/u/task-attachments/t1/a.png)',
    );
  });

  it('reports a refused upload in the daemon’s own words', async () => {
    const api = {
      addTaskAttachment: vi
        .fn()
        .mockRejectedValue(new Error('attachment exceeds the 5MB limit')),
    } as unknown as DaemonApis['tasks'];
    const harness = mount(api);

    harness.paste(clipboard(png()));
    await settle(() => !harness.state().uploading);

    expect(harness.state().error).toContain('5MB limit');
    expect(harness.state().uploading).toBe(false);
  });

  it('refuses to insert once focus has left the pasted field, reporting where the image landed instead', async () => {
    // The title `Input` is `autoFocus` and saves on blur, so a misdirected
    // insertion is not just a wrong link — it can be persisted as the title.
    const exec = stubExecCommand(true);
    const api = {
      addTaskAttachment: vi.fn().mockResolvedValue({
        path: '/u/task-attachments/t1/a.png',
        name: 'Pasted image',
      }),
    } as unknown as DaemonApis['tasks'];
    const harness = mount(api);

    const other = document.createElement('input');
    document.body.appendChild(other);

    harness.paste(clipboard(png()));
    // Focus moves away from the pasted-into field while the upload is still
    // in flight — the bytes are not back yet, so nothing has been written.
    other.focus();
    await settle(() => !harness.state().uploading);

    expect(exec).not.toHaveBeenCalled();
    expect(harness.state().error).toContain('/u/task-attachments/t1/a.png');
    other.remove();
  });

  it('says so when the file landed but the text did not', async () => {
    // The insertion can be REFUSED outright — the image is already on disk by
    // then, so silence would leave it unreachable. (The focus-loss route into
    // the same guard is pinned by its own sibling above.)
    stubExecCommand(false);
    const api = {
      addTaskAttachment: vi
        .fn()
        .mockResolvedValue({ path: '/u/a.png', name: 'x' }),
    } as unknown as DaemonApis['tasks'];
    const harness = mount(api);

    harness.paste(clipboard(png()));
    await settle(() => !harness.state().uploading);

    expect(harness.state().error).toContain('/u/a.png');
  });

  it('leaves a plain TEXT paste to the browser', () => {
    const api = {
      addTaskAttachment: vi.fn(),
    } as unknown as DaemonApis['tasks'];
    const harness = mount(api);

    expect(harness.paste(clipboard(null)).defaultPrevented).toBe(false);
    expect(api.addTaskAttachment).not.toHaveBeenCalled();
  });

  it('writes a NON-image file as its own path, uploading nothing', () => {
    // That file already IS a path, and the agent reading the description can
    // open it — the composer's own rule.
    const exec = stubExecCommand(true);
    // The app's ONE preload double, typed as `GeniroApi` — a bare object cast
    // here would defeat exactly the check that keeps it honest.
    window.geniro = createPreloadStub({ filePath: () => '/docs/spec.pdf' });
    const api = {
      addTaskAttachment: vi.fn(),
    } as unknown as DaemonApis['tasks'];
    const harness = mount(api);

    const pdf = new File([new Uint8Array([1])], 'spec.pdf', {
      type: 'application/pdf',
    });
    const result = harness.paste(clipboard(pdf));

    expect(result.defaultPrevented).toBe(true);
    expect(exec).toHaveBeenCalledWith('insertText', false, '/docs/spec.pdf');
    expect(api.addTaskAttachment).not.toHaveBeenCalled();
  });
});
