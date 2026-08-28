// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { AgentCallsCard } from './agent-calls-card';
import type { AgentCallInfo } from './node-validate';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

const WIRED: AgentCallInfo = {
  callees: ['Engineer', 'Researcher', 'QA'],
  callers: ['Lead'],
  inCycle: false,
  undescribedCallees: [],
};

function render(
  info: Partial<AgentCallInfo> = {},
  agentKind = 'claude',
): HTMLElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <AgentCallsCard info={{ ...WIRED, ...info }} agentKind={agentKind} />,
    );
  });
  return container;
}

/** The names as the reader sees them — one badge each, in order. */
function badges(el: HTMLElement): string[] {
  return [...el.querySelectorAll('[data-slot="badge"]')].map((b) =>
    (b.textContent ?? '').trim(),
  );
}

function rowLabels(el: HTMLElement): string[] {
  return [...el.querySelectorAll('[data-slot="setting-row"]')].map((row) =>
    (row.children[0]?.textContent ?? '').trim(),
  );
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

describe('AgentCallsCard', () => {
  it('states the wiring as labelled rows of names, and nothing else', () => {
    // The whole of the redesign: what a reader comes to this section for is
    // who this node can reach. It used to be the second line of a nine-line
    // wall — `May call: Engineer, Researcher, QA` — under a heading, over two
    // paragraphs that said the same thing about every node in every workflow.
    const el = render();

    expect(rowLabels(el)).toEqual(['Calls', 'Called by']);
    expect(badges(el)).toEqual(['Engineer', 'Researcher', 'QA', 'Lead']);
    // The prose is gone: it is the section's own one-line hint at the call
    // site now, not a wall re-read on every selection.
    expect(el.textContent).not.toContain('call_agent');
    expect(el.textContent).not.toContain('Call edges let this agent');
  });

  it('draws only the half a node actually has', () => {
    // A leaf callee has no callees of its own, and a row labelled `Calls` with
    // nothing under it is a heading over a hole — the same rule every picker in
    // this panel follows.
    const el = render({ callees: [], undescribedCallees: [] });

    expect(rowLabels(el)).toEqual(['Called by']);
    expect(badges(el)).toEqual(['Lead']);
  });

  it('MARKS the callee it cannot route to, on the badge that is about it', () => {
    // This replaced a sentence naming them in a list — "No description on QA —
    // this agent sees only their names and has nothing to route on". The mark
    // is on the name it is about, and its reason is that badge's own hover, so
    // a reader fixing it knows which node to open.
    const el = render({ undescribedCallees: ['QA'] });

    const qa = [...el.querySelectorAll('[data-slot="badge"]')].find(
      (b) => b.textContent?.trim() === 'QA',
    );
    expect(qa?.getAttribute('title')).toContain('no description');
    expect(qa?.className).toContain('text-warning');
    // …and the ones it CAN route to carry neither.
    const engineer = [...el.querySelectorAll('[data-slot="badge"]')].find(
      (b) => b.textContent?.trim() === 'Engineer',
    );
    expect(engineer?.getAttribute('title')).toBeNull();
    expect(engineer?.className).not.toContain('text-warning');
  });

  it('keeps the loop warning, which is true of this node and nothing else', () => {
    const plain = render({ inCycle: false });
    expect(plain.textContent).not.toContain('call loop');
    act(() => root?.unmount());
    container?.remove();

    const looped = render({ inCycle: true });
    expect(looped.textContent).toContain('call loop');
  });

  it('warns about escalation only on the CLI that cannot do it', () => {
    // A per-CLI limitation is a fact about THIS node. claude's own path — the
    // question reaches the caller, which answers it or escalates — is what a
    // reader would assume, so stating it was a line that told them nothing.
    const claude = render({}, 'claude');
    expect(claude.textContent).not.toContain('escalate');
    act(() => root?.unmount());
    container?.remove();

    const cursor = render({}, 'cursor-agent');
    expect(cursor.textContent).toContain('escalate');
  });

  it('says nothing about escalation on a node that calls no one', () => {
    // It is a caveat about handling a CALLEE's question; a node with no
    // callees will never receive one.
    const el = render({ callees: [], undescribedCallees: [] }, 'cursor-agent');

    expect(el.textContent).not.toContain('escalate');
  });
});
