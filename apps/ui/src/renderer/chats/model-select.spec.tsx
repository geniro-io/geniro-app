// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { ModelEffortReadout } from './model-effort-readout';
import { ModelSelect } from './model-select';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function render(element: React.ReactElement): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(element);
  });
  return container;
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

describe('ModelSelect', () => {
  it('shows a loader instead of the default row while models are still fetching', () => {
    const el = render(
      <ModelSelect
        agentKind="cursor-agent"
        models={[]}
        loading
        value={null}
        onChange={() => {}}
      />,
    );
    expect(el.textContent).toContain('Loading models…');
    expect(el.querySelector('[data-menu-trigger]')).toBeNull();
    expect(el.querySelector('.animate-spin')).not.toBeNull();
  });
});

describe('ModelEffortReadout', () => {
  it('states the effort baked into a cursor model id', () => {
    const el = render(
      <ModelEffortReadout
        agentKind="cursor-agent"
        modelId="claude-opus-5[thinking=true,context=300k,effort=high,fast=false]"
      />,
    );
    expect(el.textContent).toContain('high');
  });

  it('tells the user HOW to change an effort it cannot change itself', () => {
    // The ticket item was "cursor's effort isn't changeable". It genuinely is
    // not — the agent rejects every recomposed model id (see the adapter's
    // `efforts` field for the probe) — so the only fix available is for the chip
    // to name the action that does work. Stating the value alone is what made it
    // read as a broken control. Trim this sentence back and the item returns.
    const el = render(
      <ModelEffortReadout
        agentKind="cursor-agent"
        modelId="claude-opus-5[thinking=true,context=300k,effort=high,fast=false]"
      />,
    );
    const title = el.querySelector('[title]')?.getAttribute('title') ?? '';
    expect(title).toContain('high');
    expect(title).toContain('choosing a different model');
  });

  it('renders nothing for claude, which has its own effort picker', () => {
    const el = render(
      <ModelEffortReadout
        agentKind="claude"
        modelId="claude-opus-5[effort=high]"
      />,
    );
    expect(el.textContent).toBe('');
  });

  it('renders nothing on the CLI default, where no id is chosen yet', () => {
    const el = render(
      <ModelEffortReadout agentKind="cursor-agent" modelId={null} />,
    );
    expect(el.textContent).toBe('');
  });
});
