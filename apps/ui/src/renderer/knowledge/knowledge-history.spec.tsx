// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  aKnowledgeDocument,
  aKnowledgeRevision,
} from '../__fixtures__/knowledge';
import type { DaemonApis } from '../daemon-api';
import { KnowledgeHistory } from './knowledge-history';

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

async function showVersion(
  version: ReturnType<typeof aKnowledgeRevision>,
): Promise<HTMLDivElement> {
  const apis = {
    knowledge: {
      listKnowledgeRevisions: vi.fn().mockResolvedValue({
        revisions: [version],
      }),
      readKnowledgeRevision: vi.fn().mockResolvedValue(version),
    },
  } as unknown as DaemonApis;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <KnowledgeHistory
        apis={apis}
        document={aKnowledgeDocument()}
        onBack={() => undefined}
        onRestore={async () => undefined}
      />,
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return container;
}

describe('KnowledgeHistory', () => {
  it('says there is no diff when the version before is still kept', async () => {
    const el = await showVersion(
      aKnowledgeRevision({
        status: 'applied',
        rev: 6,
        diff: '',
        baseKept: true,
      }),
    );

    expect(el.textContent).toContain(
      'There is no line-by-line diff for this version.',
    );
    expect(el.textContent).not.toContain('no longer kept');
  });

  it('says the version before is no longer kept once it was dropped', async () => {
    const el = await showVersion(
      aKnowledgeRevision({
        status: 'applied',
        rev: 6,
        diff: '',
        baseKept: false,
      }),
    );

    expect(el.textContent).toContain(
      'The version before this one is no longer kept.',
    );
    expect(el.textContent).not.toContain('no line-by-line diff');
  });
});
