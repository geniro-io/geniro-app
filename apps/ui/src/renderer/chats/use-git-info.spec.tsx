// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import type { GitInfo } from '../../shared/contracts';
import { createPreloadStub } from '../__fixtures__/preload-stub';
import { useGitInfo } from './use-git-info';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  delete (window as { geniro?: unknown }).geniro;
});

const REPO: GitInfo = {
  isRepo: true,
  branch: 'main',
  branches: ['main'],
  dirty: false,
  worktrees: [],
  worktreeOf: null,
};

describe('useGitInfo', () => {
  it('hands every render the same reading until git answers something new', async () => {
    window.geniro = createPreloadStub({
      getGitInfo: () => Promise.resolve(REPO),
    });
    const seen: ReturnType<typeof useGitInfo>[] = [];
    function Probe(): null {
      seen.push(useGitInfo('/repo'));
      return null;
    }
    await act(async () => {
      root = createRoot(document.createElement('div'));
      root.render(<Probe />);
    });
    const answered = seen.at(-1)!;
    expect(answered.info).toEqual(REPO);

    act(() => root?.render(<Probe />));

    expect(seen.at(-1)).toBe(answered);
  });
});
