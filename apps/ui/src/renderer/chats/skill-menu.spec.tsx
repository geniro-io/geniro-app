// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentSkill } from '../../shared/contracts';
import { SkillMenu } from './skill-menu';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: { root: Root; container: HTMLElement }[] = [];

async function mount(ui: React.ReactElement): Promise<HTMLElement> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => {
    root.render(ui);
  });
  return container;
}

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

const SKILLS: AgentSkill[] = [
  {
    name: 'deploy',
    description: 'Ship the app',
    kind: 'skill',
    source: 'project',
  },
  { name: 'review', description: null, kind: 'command', source: 'user' },
];

describe('SkillMenu', () => {
  it('renders one option per skill with name, description, and source', async () => {
    const container = await mount(
      <SkillMenu
        skills={SKILLS}
        highlightIndex={0}
        onSelect={vi.fn()}
        onHighlight={vi.fn()}
      />,
    );
    const options = container.querySelectorAll('[role="option"]');
    expect(options).toHaveLength(2);
    expect(options[0]!.textContent).toContain('/deploy');
    expect(options[0]!.textContent).toContain('Ship the app');
    expect(options[0]!.textContent).toContain('project');
    expect(options[1]!.textContent).toContain('/review');
    expect(options[1]!.textContent).toContain('user');
  });

  it('marks exactly the highlighted row aria-selected', async () => {
    const container = await mount(
      <SkillMenu
        skills={SKILLS}
        highlightIndex={1}
        onSelect={vi.fn()}
        onHighlight={vi.fn()}
      />,
    );
    const options = container.querySelectorAll('[role="option"]');
    expect(options[0]!.getAttribute('aria-selected')).toBe('false');
    expect(options[1]!.getAttribute('aria-selected')).toBe('true');
  });

  it('reports clicks as selection and hover as highlight movement', async () => {
    const onSelect = vi.fn();
    const onHighlight = vi.fn();
    const container = await mount(
      <SkillMenu
        skills={SKILLS}
        highlightIndex={0}
        onSelect={onSelect}
        onHighlight={onHighlight}
      />,
    );
    const options = container.querySelectorAll('[role="option"]');
    await act(async () => {
      options[1]!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onSelect).toHaveBeenCalledWith(SKILLS[1]);
    await act(async () => {
      options[1]!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    expect(onHighlight).toHaveBeenCalledWith(1);
  });
});
