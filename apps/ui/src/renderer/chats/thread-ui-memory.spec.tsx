// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import {
  forgetThread,
  MAX_FLAGS_PER_THREAD,
  MAX_REMEMBERED_THREADS,
  readThreadFlag,
  ThreadUiMemoryContext,
  useThreadFlag,
  useThreadOverride,
  writeThreadFlag,
} from './thread-ui-memory';

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
  localStorage.clear();
});

/** A fold reading one flag, so its value is observable in the DOM. */
function Fold({ memoryKey }: { memoryKey?: string }): React.JSX.Element {
  const [open, setOpen] = useThreadFlag(memoryKey, false);
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={() => setOpen((v) => !v)}>
      {open ? 'open' : 'shut'}
    </button>
  );
}

/** A fold whose default is derived, like a tool group holding a diff. */
function DerivedFold({ derived }: { derived: boolean }): React.JSX.Element {
  const [override, setOverride] = useThreadOverride('derived');
  const open = override ?? derived;
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={() => setOverride(!open)}>
      {open ? 'open' : 'shut'}
    </button>
  );
}

function render(node: React.ReactElement): void {
  if (root === null) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  }
  act(() => root!.render(node));
}

const button = (): HTMLButtonElement => container!.querySelector('button')!;

describe('thread UI memory', () => {
  it('keeps a fold per thread across a thread switch and back', () => {
    // The reported defect: a fold opened in one thread came undone on leaving
    // it, and the agents panel's fold followed the user into every thread.
    render(
      <ThreadUiMemoryContext.Provider value="a">
        <Fold memoryKey="block" />
      </ThreadUiMemoryContext.Provider>,
    );
    act(() => button().click());
    expect(button().textContent).toBe('open');

    render(
      <ThreadUiMemoryContext.Provider value="b">
        <Fold memoryKey="block" />
      </ThreadUiMemoryContext.Provider>,
    );
    expect(button().textContent).toBe('shut');

    render(
      <ThreadUiMemoryContext.Provider value="a">
        <Fold memoryKey="block" />
      </ThreadUiMemoryContext.Provider>,
    );
    expect(button().textContent).toBe('open');
  });

  it('survives the fold being unmounted, which is what leaving a thread does', () => {
    render(
      <ThreadUiMemoryContext.Provider value="a">
        <Fold memoryKey="block" />
      </ThreadUiMemoryContext.Provider>,
    );
    act(() => button().click());
    render(
      <ThreadUiMemoryContext.Provider value="a">
        {null}
      </ThreadUiMemoryContext.Provider>,
    );
    render(
      <ThreadUiMemoryContext.Provider value="a">
        <Fold memoryKey="block" />
      </ThreadUiMemoryContext.Provider>,
    );
    expect(button().textContent).toBe('open');
  });

  it('remembers a press that SHUT a fold whose default is open', () => {
    // `false` is a choice, not "never pressed" — reading it as absent would
    // make shut the one state a self-opening block could not remember.
    render(
      <ThreadUiMemoryContext.Provider value="a">
        <DerivedFold derived />
      </ThreadUiMemoryContext.Provider>,
    );
    act(() => button().click());
    render(
      <ThreadUiMemoryContext.Provider value="a">
        {null}
      </ThreadUiMemoryContext.Provider>,
    );
    render(
      <ThreadUiMemoryContext.Provider value="a">
        <DerivedFold derived />
      </ThreadUiMemoryContext.Provider>,
    );
    expect(button().textContent).toBe('shut');
    expect(readThreadFlag('a', 'derived')).toBe(false);
  });

  it('is plain component state outside a thread, and writes nothing', () => {
    render(<Fold memoryKey="block" />);
    act(() => button().click());
    expect(button().textContent).toBe('open');
    render(<>{null}</>);
    render(<Fold memoryKey="block" />);
    expect(button().textContent).toBe('shut');
    expect(localStorage.length).toBe(0);
  });

  it('wakes a mounted reader when a write comes from elsewhere', () => {
    // The shelf's "All N" opens the panel's fold from another subtree.
    render(
      <ThreadUiMemoryContext.Provider value="a">
        <Fold memoryKey="block" />
      </ThreadUiMemoryContext.Provider>,
    );
    act(() => writeThreadFlag('a', 'block', true));
    expect(button().textContent).toBe('open');
    act(() => forgetThread('a'));
    expect(button().textContent).toBe('shut');
  });

  it('forgets the least recently touched thread past the cap', () => {
    writeThreadFlag('first', 'block', true);
    for (let i = 0; i < MAX_REMEMBERED_THREADS; i += 1) {
      writeThreadFlag(`t-${i}`, 'block', true);
    }
    expect(readThreadFlag('first', 'block')).toBeNull();
    expect(localStorage.getItem('geniro.threadUi.first')).toBeNull();
    expect(readThreadFlag(`t-${MAX_REMEMBERED_THREADS - 1}`, 'block')).toBe(
      true,
    );
  });

  it('forgets the least recently pressed fold past the per-thread cap', () => {
    for (let i = 0; i <= MAX_FLAGS_PER_THREAD; i += 1) {
      writeThreadFlag('a', `row-${i}`, true);
    }
    expect(readThreadFlag('a', 'row-0')).toBeNull();
    expect(readThreadFlag('a', `row-${MAX_FLAGS_PER_THREAD}`)).toBe(true);
  });

  it('reads a corrupt entry as nothing remembered rather than throwing', () => {
    localStorage.setItem('geniro.threadUi.a', '{not json');
    expect(readThreadFlag('a', 'block')).toBeNull();
    writeThreadFlag('a', 'block', true);
    expect(readThreadFlag('a', 'block')).toBe(true);
  });
});
