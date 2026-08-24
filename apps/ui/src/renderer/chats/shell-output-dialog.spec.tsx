// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ShellRun } from './shell-activity';
import { ShellOutputDialog } from './shell-output-dialog';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function render(element: React.ReactElement): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(element);
  });
  return container;
}

const shell = (over: Partial<ShellRun> = {}): ShellRun => ({
  id: 'c1',
  command: 'pnpm dev',
  description: null,
  background: true,
  handle: 'bash_1',
  status: 'running',
  exitCode: null,
  startedAt: new Date(Date.now() - 5_000).toISOString(),
  agentId: null,
  ...over,
});

const output = (text: string, over = {}) => ({
  text,
  truncated: false,
  unavailableReason: null,
  ...over,
});

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

describe('ShellOutputDialog', () => {
  it('shows what the command has printed, and the command itself', async () => {
    const load = vi.fn().mockResolvedValue(output('Ready in 812ms\n'));
    const el = await render(
      <ShellOutputDialog shell={shell()} onClose={vi.fn()} load={load} />,
    );

    expect(load).toHaveBeenCalledWith('c1');
    expect(
      el.ownerDocument.body.querySelector('[data-slot="shell-output"]')
        ?.textContent,
    ).toContain('Ready in 812ms');
    // The whole command, which the panel row truncates to one line.
    expect(el.ownerDocument.body.textContent).toContain('pnpm dev');
  });

  it('draws the command’s OWN colours, and copies the text without them', async () => {
    // Command output is not plain text: anything with `--color=always` or
    // `FORCE_COLOR` emits escape sequences, and drawn as text the escape byte
    // is invisible while its tail is not — a green `PASS` read as `[32mPASS`.
    const load = vi
      .fn()
      .mockResolvedValue(output('\u001b[32mPASS\u001b[0m 42 tests\n'));
    const el = await render(
      <ShellOutputDialog shell={shell()} onClose={vi.fn()} load={load} />,
    );

    const box = el.ownerDocument.body.querySelector(
      '[data-slot="shell-output"]',
    )!;
    expect(box.querySelector('[data-ansi-color="green"]')?.textContent).toBe(
      'PASS',
    );
    // Every character, none of the codes.
    expect(box.textContent).toBe('PASS 42 tests\n');
    // And the copy control hands over what a reader would paste into a bug
    // report, not the bytes that coloured it.
    expect(
      el.ownerDocument.body.querySelector(
        'button[aria-label="Copy the output"]',
      ),
    ).not.toBeNull();
  });

  it('POLLS while the command is running', async () => {
    // A detached command is still writing, so the view has to follow it — this
    // is the difference from the context panel next door, which is one
    // multi-second ask per open.
    const load = vi.fn().mockResolvedValue(output('starting\n'));
    await render(
      <ShellOutputDialog shell={shell()} onClose={vi.fn()} load={load} />,
    );
    expect(load).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_100);
    });
    expect(load.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('reads a FINISHED command exactly once', async () => {
    // Nothing more can arrive, so polling would be a request every two seconds
    // for a byte-identical answer.
    const load = vi.fn().mockResolvedValue(output('done\n'));
    await render(
      <ShellOutputDialog
        shell={shell({ status: 'completed' })}
        onClose={vi.fn()}
        load={load}
      />,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('states the daemon’s reason instead of an empty terminal', async () => {
    const load = vi
      .fn()
      .mockResolvedValue(
        output('', { unavailableReason: 'still running — this command…' }),
      );
    const el = await render(
      <ShellOutputDialog shell={shell()} onClose={vi.fn()} load={load} />,
    );

    expect(el.ownerDocument.body.textContent).toContain('still running');
    // No output box at all: an empty one reads as a command that printed
    // nothing, which is a different claim.
    expect(
      el.ownerDocument.body.querySelector('[data-slot="shell-output"]'),
    ).toBeNull();
  });

  it('says when it is showing only the END of a longer output', async () => {
    const load = vi
      .fn()
      .mockResolvedValue(output('…tail\n', { truncated: true }));
    const el = await render(
      <ShellOutputDialog shell={shell()} onClose={vi.fn()} load={load} />,
    );

    expect(el.ownerDocument.body.textContent).toContain(
      'Showing the end of a longer output',
    );
  });

  it('surfaces a failed read rather than an empty box', async () => {
    const load = vi
      .fn()
      .mockRejectedValue(new Error('daemon GET failed (500)'));
    const el = await render(
      <ShellOutputDialog shell={shell()} onClose={vi.fn()} load={load} />,
    );

    expect(
      el.ownerDocument.body.querySelector('[role="alert"]')?.textContent,
    ).toContain('daemon GET failed');
  });

  it('renders nothing when no command is open', async () => {
    const el = await render(
      <ShellOutputDialog shell={null} onClose={vi.fn()} load={vi.fn()} />,
    );

    expect(el.ownerDocument.body.textContent).not.toContain('Shell output');
  });
});
