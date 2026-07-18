// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ChatItem } from '../../shared/contracts';
import { ToolGroup } from './tool-group';
import { groupTranscript, type ToolGroupEntry } from './transcript-groups';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let seq = 0;
function toolItem(
  kind: 'tool_call' | 'tool_result',
  payload: unknown,
): ChatItem {
  seq += 1;
  return {
    id: `i-${seq}`,
    runId: 'run-1',
    nodeId: 'orch',
    seq,
    kind,
    role: null,
    payload,
    createdAt: 'now',
  };
}

function makeGroup(items: ChatItem[]): ToolGroupEntry {
  const group = groupTranscript(items)[0];
  if (group?.type !== 'tools') {
    throw new Error('expected a tool group');
  }
  return group;
}

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

function render(group: ToolGroupEntry): void {
  act(() => root.render(<ToolGroup group={group} />));
}

function click(el: Element | null): void {
  act(() => {
    el?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

describe('ToolGroup', () => {
  const bashGroup = (): ToolGroupEntry =>
    makeGroup([
      toolItem('tool_call', {
        id: 't1',
        name: 'Bash',
        input: { command: 'ls -la' },
      }),
      toolItem('tool_result', { id: 't1', name: null, result: 'file-list' }),
      toolItem('tool_call', {
        id: 't2',
        name: 'Read',
        input: { file_path: '/proj/a.ts' },
      }),
      toolItem('tool_result', { id: 't2', name: null, result: 'contents' }),
    ]);

  it('is COLLAPSED by default: the summary line shows, the tool rows and payloads do not', () => {
    render(bashGroup());

    // The sender frame around the group names the agent — the summary line
    // itself stays name-free.
    expect(container.textContent).toContain('Used 2 tools · ran 1 command');
    expect(container.textContent).not.toContain('ls -la');
    expect(container.textContent).not.toContain('file-list');
    const header = container.querySelector('button[aria-expanded]');
    expect(header?.getAttribute('aria-expanded')).toBe('false');
  });

  it('expands to one row per tool, and a row expands to the full input + result', () => {
    render(bashGroup());

    click(container.querySelector('button[aria-expanded]'));
    // Row headers now visible: name + one-line arg preview, details still not.
    expect(container.textContent).toContain('Bash');
    expect(container.textContent).toContain('ls -la');
    expect(container.textContent).not.toContain('file-list');

    const rows = [...container.querySelectorAll('button[aria-expanded]')];
    click(rows[1] ?? null); // first tool row (index 0 is the group header)
    expect(container.textContent).toContain('"command": "ls -la"');
    expect(container.textContent).toContain('file-list');
    expect(container.textContent).toContain('result');
  });

  it('renders Edit inputs as a red/green diff instead of raw JSON', () => {
    render(
      makeGroup([
        toolItem('tool_call', {
          id: 't1',
          name: 'Edit',
          input: {
            file_path: '/proj/a.ts',
            old_string: 'const a = 1;',
            new_string: 'const a = 2;',
          },
        }),
      ]),
    );

    click(container.querySelector('button[aria-expanded]'));
    const rows = [...container.querySelectorAll('button[aria-expanded]')];
    click(rows[1] ?? null);

    const diff = container.querySelector('[data-slot="diff"]');
    expect(diff).not.toBeNull();
    expect(diff?.textContent).toContain('-');
    expect(diff?.textContent).toContain('const a = 1;');
    expect(diff?.textContent).toContain('+');
    expect(diff?.textContent).toContain('const a = 2;');
    // The raw JSON body is replaced by the diff for edits.
    expect(container.textContent).not.toContain('"old_string"');
  });

  it('marks a still-running tool (no result yet) with an ellipsis', () => {
    render(
      makeGroup([
        toolItem('tool_call', {
          id: 't1',
          name: 'Bash',
          input: { command: 'sleep 5' },
        }),
      ]),
    );

    click(container.querySelector('button[aria-expanded]'));
    expect(container.textContent).toContain('…');
  });
});
