// @vitest-environment jsdom
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';

// eslint-disable-next-line no-restricted-syntax -- the control the hook is measured against
import { act, type DependencyList, useCallback } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { useLatestCallback } from './use-latest-callback';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

setFlagsFromString('--expose_gc');
const collectGarbage = runInNewContext('gc') as () => void;

type Read = () => object | null;
type Memoize = (callback: Read, deps: DependencyList) => Read;

let root: Root | null = null;
let read: Read | null = null;
let renders = 0;
/** Handed to the next render outside its props, so only closures hold it. */
let nextPayload: object | null = null;

function Probe({
  version,
  memoize,
}: {
  version: number;
  memoize: Memoize;
  render: number;
}): null {
  const payload = nextPayload;
  read = memoize(() => payload, [version]);
  return null;
}

function render(payload: object, version: number, memoize: Memoize): Read {
  nextPayload = payload;
  renders += 1;
  act(() => {
    root!.render(
      <Probe version={version} memoize={memoize} render={renders} />,
    );
  });
  nextPayload = null;
  return read!;
}

function mount(): void {
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
}

function plain(callback: Read): Read {
  return callback;
}

/** Renders three times under unchanged deps and hands back the first payload. */
function renderPastFirstPayload(memoize: Memoize): WeakRef<object> {
  const first = { render: 1 };
  render(first, 0, memoize);
  render({ render: 2 }, 0, memoize);
  render({ render: 3 }, 0, memoize);
  return new WeakRef(first);
}

async function collected(ref: WeakRef<object>): Promise<boolean> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  collectGarbage();
  return ref.deref() === undefined;
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  read = null;
  document.body.innerHTML = '';
});

describe('useLatestCallback', () => {
  it('keeps its identity while deps hold and changes it when they change', () => {
    mount();
    const first = render({}, 0, useLatestCallback);
    expect(render({}, 0, useLatestCallback)).toBe(first);
    expect(render({}, 1, useLatestCallback)).not.toBe(first);
  });

  it("runs the latest render's callback, not the one its identity was made in", () => {
    mount();
    const kept = render({ render: 1 }, 0, useLatestCallback);
    const latest = { render: 2 };
    render(latest, 0, useLatestCallback);
    expect(kept()).toBe(latest);
  });

  it("lets an earlier render's scope be collected, which useCallback keeps", async () => {
    mount();
    expect(await collected(renderPastFirstPayload(plain))).toBe(true);
    act(() => root?.unmount());
    mount();
    expect(await collected(renderPastFirstPayload(useCallback))).toBe(false);
    act(() => root?.unmount());
    mount();
    expect(await collected(renderPastFirstPayload(useLatestCallback))).toBe(
      true,
    );
  });
});
