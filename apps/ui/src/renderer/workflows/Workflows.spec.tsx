// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DaemonHandle } from '../../shared/contracts';
import { createPreloadStub } from '../__fixtures__/preload-stub';
import { stubResizeObserver } from '../__tests__/stub-resize-observer';
import { Workflows } from './Workflows';

const { listWorkflows } = vi.hoisted(() => ({
  listWorkflows: vi.fn(async () => []),
}));

// The canvas mounts only once a workflow is open, which the library grid this
// spec exercises never does — but the module is imported at module scope and
// drags in a stylesheet plus measurement code that answers 0x0 under jsdom.
vi.mock('@xyflow/react', () => ({
  addEdge: vi.fn(),
  Background: () => null,
  Controls: () => null,
  PanOnScrollMode: { Free: 'free' },
  ReactFlow: () => null,
  useEdgesState: () => [[], vi.fn(), vi.fn()],
  useNodesState: () => [[], vi.fn(), vi.fn()],
}));
vi.mock('@xyflow/react/dist/style.css', () => ({}));

vi.mock('../daemon-api', () => ({
  createDaemonApis: () => ({
    workflows: {
      listWorkflows,
      listWorkflowRuns: vi.fn(async () => []),
    },
    capabilities: { getCapabilities: vi.fn(async () => ({})) },
    agents: {
      listAgentModels: vi.fn(async () => []),
      listAgentEfforts: vi.fn(async () => []),
      listAgentContextWindows: vi.fn(async () => []),
      listAgentModelParameters: vi.fn(async () => []),
    },
  }),
}));

const HANDLE = { host: '127.0.0.1', port: 1, token: 't' } as DaemonHandle;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  stubResizeObserver();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  window.geniro = createPreloadStub();
  listWorkflows.mockClear();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

async function paint(active: boolean): Promise<void> {
  await act(async () => {
    root.render(<Workflows handle={HANDLE} active={active} />);
  });
}

describe('Workflows — the library list', () => {
  /**
   * The library is `*.geniro.yaml` on disk, and this screen stays MOUNTED while
   * hidden so an unsaved builder edit survives a glance at Chats. Without a
   * refresh on the way back in, the mount read is the only one that ever runs,
   * and a workflow written by an editor, another window or a second checkout
   * stays invisible until the app restarts.
   *
   * Reverting the `active` guard makes the effect a one-shot again — its only
   * other dependency, `refreshList`, is stable across these renders — so the
   * third assertion drops back to one call.
   */
  it('re-reads the library when the screen comes back into view', async () => {
    await paint(true);
    expect(listWorkflows).toHaveBeenCalledTimes(1);

    await paint(false);
    expect(listWorkflows).toHaveBeenCalledTimes(1);

    await paint(true);
    expect(listWorkflows).toHaveBeenCalledTimes(2);
  });

  it('does not read the library while the screen is hidden', async () => {
    await paint(false);
    expect(listWorkflows).not.toHaveBeenCalled();
  });
});
