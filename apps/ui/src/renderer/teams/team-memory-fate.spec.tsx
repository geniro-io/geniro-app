// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DaemonApis } from '../daemon-api';
import { type TeamMemoryFate, TeamMemoryFatePick } from './team-memory-fate';

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

function apisListing(
  count: number,
  more = false,
): {
  apis: DaemonApis;
  listMemories: ReturnType<typeof vi.fn>;
} {
  const listMemories = vi.fn(async () => ({
    memories: Array.from({ length: count }, (_, index) => ({
      id: `e${index}`,
    })),
    next: more ? { beforeUpdatedAt: 'x', beforeId: 'y' } : null,
  }));
  return {
    apis: { memories: { listMemories } } as unknown as DaemonApis,
    listMemories,
  };
}

async function draw(
  apis: DaemonApis,
  onChange: (fate: TeamMemoryFate) => void = () => undefined,
): Promise<void> {
  await act(async () => {
    root.render(
      <TeamMemoryFatePick
        apis={apis}
        slug="dev"
        value="forget"
        onChange={onChange}
      />,
    );
  });
}

describe('TeamMemoryFatePick', () => {
  it('asks nothing when the team keeps no memories', async () => {
    const { apis, listMemories } = apisListing(0);
    await draw(apis);

    expect(listMemories).toHaveBeenCalledWith({
      scope: 'team',
      teamSlug: 'dev',
      limit: 200,
    });
    expect(
      container.querySelector('[data-slot="team-memory-fate"]'),
    ).toBeNull();
  });

  it('counts the team’s memories and hands back the fate picked', async () => {
    const { apis } = apisListing(3);
    const onChange = vi.fn();
    await draw(apis, onChange);

    expect(container.textContent).toContain('This team keeps 3 memories.');
    const global = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Move them to Global'),
    )!;
    await act(async () => {
      global.click();
    });
    expect(onChange).toHaveBeenCalledWith('global');
  });

  it('says "or more" past one page of entries', async () => {
    const { apis } = apisListing(200, true);
    await draw(apis);

    expect(container.textContent).toContain('200 or more memories');
  });
});
