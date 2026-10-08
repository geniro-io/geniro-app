// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { AgentPoolLabel } from './agent-pool-label';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function render(element: React.ReactElement): HTMLDivElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(element);
  });
  return host;
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  host?.remove();
  root = null;
  host = null;
});

describe('AgentPoolLabel', () => {
  it('names the first member and counts the rest in ONE label', () => {
    const el = render(
      <AgentPoolLabel
        members={[
          { name: 'claude', model: 'opus' },
          { name: 'codex', model: 'gpt-6.1-sol' },
        ]}
      />,
    );
    const badges = el.querySelectorAll('[data-slot="badge"]');
    expect(badges).toHaveLength(1);
    expect(badges[0]!.textContent).toBe('claude+1');
  });

  it('lists every member, numbered, with model and profile, on a press', () => {
    const el = render(
      <AgentPoolLabel
        members={[
          { name: 'claude', model: 'opus', profile: '/Users/me/.claude-work' },
          { name: 'codex', model: 'gpt-6.1-sol', profile: null },
        ]}
      />,
    );
    expect(el.querySelector('[data-slot="agent-pool-members"]')).toBeNull();
    act(() => {
      el.querySelector<HTMLButtonElement>('button')!.click();
    });
    const rows = [
      ...el.querySelectorAll('[data-slot="agent-pool-member"]'),
    ].map((row) => row.textContent);
    expect(rows).toEqual(['1claudeopus.claude-work', '2codexgpt-6.1-sol']);
  });

  it('is a plain badge with no control for a single agent', () => {
    const el = render(
      <AgentPoolLabel members={[{ name: 'cursor', model: null }]} />,
    );
    expect(el.textContent).toBe('cursor');
    expect(el.querySelector('button')).toBeNull();
  });

  it('draws nothing for an empty member list', () => {
    const el = render(<AgentPoolLabel members={[]} />);
    expect(el.innerHTML).toBe('');
  });
});
