// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { GitInfo } from '../../shared/contracts';
import { createPreloadStub } from '../__fixtures__/preload-stub';
import { useWorktreeOrigin } from './use-worktree-origin';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
  vi.restoreAllMocks();
});

const info = (worktreeOf: string | null): GitInfo => ({
  isRepo: true,
  branch: 'geniro/task-t1',
  branches: ['geniro/task-t1', 'main'],
  dirty: false,
  worktrees: [],
  worktreeOf,
});

function Probe({ dir }: { dir: string | null }): React.JSX.Element {
  return <span>{useWorktreeOrigin(dir) ?? 'none'}</span>;
}

function render(dir: string | null): void {
  act(() => {
    root!.render(<Probe dir={dir} />);
  });
}

function mount(dir: string | null): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  render(dir);
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('useWorktreeOrigin', () => {
  it('names the repository a worktree was cut from', async () => {
    window.geniro = createPreloadStub({
      getGitInfo: vi.fn(async () => info('/repos/geniro-app')),
    });

    mount('/userData/worktrees/t1');
    await flush();

    expect(container!.textContent).toBe('/repos/geniro-app');
  });

  it('reads nothing at all for a run with no folder', async () => {
    const getGitInfo = vi.fn(async () => info('/repos/geniro-app'));
    window.geniro = createPreloadStub({ getGitInfo });

    mount(null);
    await flush();

    expect(getGitInfo).not.toHaveBeenCalled();
    expect(container!.textContent).toBe('none');
  });

  it('never shows the previous folder’s repository while the next is read', async () => {
    let answerSecond: (value: GitInfo) => void = () => {};
    const getGitInfo = vi
      .fn<(dir: string) => Promise<GitInfo>>()
      .mockResolvedValueOnce(info('/repos/first'))
      .mockImplementationOnce(
        () =>
          new Promise<GitInfo>((resolve) => {
            answerSecond = resolve;
          }),
      );
    window.geniro = createPreloadStub({ getGitInfo });

    mount('/userData/worktrees/a');
    await flush();
    expect(container!.textContent).toBe('/repos/first');

    render('/userData/worktrees/b');
    expect(container!.textContent).toBe('none');

    await act(async () => {
      answerSecond(info('/repos/second'));
      await Promise.resolve();
    });
    expect(container!.textContent).toBe('/repos/second');
  });
});
