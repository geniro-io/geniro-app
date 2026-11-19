// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ArchiveThreadButton,
  ArchiveThreadIcon,
  ThreadArchiveContext,
  type ThreadArchiveOf,
  useThreadArchive,
} from './thread-archive';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function click(el: Element | null): void {
  act(() => {
    (el as HTMLElement).click();
  });
}

function Probe({ runId }: { runId: string | null | undefined }): ReactElement {
  const archive = useThreadArchive(runId);
  return (
    <button
      type="button"
      data-slot="probe"
      disabled={archive === null}
      onClick={() => archive?.()}>
      Probe
    </button>
  );
}

function renderProbe(
  runId: string | null | undefined,
  archiveOf: ThreadArchiveOf | null,
): HTMLButtonElement {
  act(() => {
    root.render(
      <ThreadArchiveContext.Provider value={archiveOf}>
        <Probe runId={runId} />
      </ThreadArchiveContext.Provider>,
    );
  });
  return container.querySelector<HTMLButtonElement>('[data-slot="probe"]')!;
}

describe('useThreadArchive', () => {
  it('offers no archive with no provider standing', () => {
    expect(renderProbe('run-1', null).disabled).toBe(true);
  });

  it('offers no archive for a thread the provider answers null for', () => {
    const archiveOf = vi.fn<ThreadArchiveOf>(() => null);

    expect(renderProbe('run-1', archiveOf).disabled).toBe(true);
    expect(archiveOf).toHaveBeenCalledWith('run-1');
  });

  it('offers no archive without a thread to ask about', () => {
    const archiveOf = vi.fn<ThreadArchiveOf>(() => vi.fn());

    expect(renderProbe(null, archiveOf).disabled).toBe(true);
    expect(renderProbe(undefined, archiveOf).disabled).toBe(true);
    expect(archiveOf).not.toHaveBeenCalled();
  });

  it('hands back the provider action for the thread, and runs it on click', () => {
    const archive = vi.fn();
    const archiveOf = vi.fn<ThreadArchiveOf>(() => archive);

    const probe = renderProbe('run-1', archiveOf);

    expect(probe.disabled).toBe(false);
    expect(archiveOf).toHaveBeenCalledWith('run-1');
    click(probe);
    expect(archive).toHaveBeenCalledTimes(1);
  });
});

describe('ArchiveThreadIcon', () => {
  it('archives the thread it is drawn for on click', () => {
    const onArchive = vi.fn();
    act(() => {
      root.render(
        <ArchiveThreadIcon
          title="Fix the login redirect"
          onArchive={onArchive}
        />,
      );
    });

    const icon = container.querySelector('[data-slot="thread-head-archive"]');
    expect(icon?.getAttribute('aria-label')).toBe(
      'Archive Fix the login redirect',
    );
    click(icon);
    expect(onArchive).toHaveBeenCalledTimes(1);
  });
});

describe('ArchiveThreadButton', () => {
  it('draws its labelled button in the slot it is given, and archives on click', () => {
    const onArchive = vi.fn();
    act(() => {
      root.render(
        <ArchiveThreadButton
          slot="thread-card-archive"
          title="Fix the login redirect"
          onArchive={onArchive}
        />,
      );
    });

    const button = container.querySelector('[data-slot="thread-card-archive"]');
    expect(button?.textContent?.trim()).toBe('Archive');
    expect(button?.getAttribute('aria-label')).toBe(
      'Archive Fix the login redirect',
    );
    click(button);
    expect(onArchive).toHaveBeenCalledTimes(1);
  });
});
