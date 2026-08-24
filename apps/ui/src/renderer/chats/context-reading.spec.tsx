// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type ContextReading, useContextReadings } from './context-reading';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let api: ReturnType<typeof useContextReadings>;

function Probe(): null {
  api = useContextReadings();
  return null;
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<Probe />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const reading = (tokens: number, window: number | null): ContextReading => ({
  tokens,
  window,
});

describe('useContextReadings', () => {
  it('hands a run back its OWN last reading, never a neighbour’s', () => {
    // The whole correctness argument for a cache that exists to cover a chat
    // switch: it is keyed by run, so the figure it re-shows can only belong to
    // the chat whose name is above it. A cache that could answer with another
    // run's reading would BE the reported bug rather than fix it.
    api.remember('run-a', reading(44_000, 1_000_000));
    api.remember('run-b', reading(43_100, 1_000_000));

    expect(api.recall('run-a')).toEqual(reading(44_000, 1_000_000));
    expect(api.recall('run-b')).toEqual(reading(43_100, 1_000_000));
    expect(api.recall('run-never-opened')).toBeNull();
    expect(api.recall(null)).toBeNull();
  });

  it('does not let a null ERASE what it holds', () => {
    // Null is exactly the state this covers — the stretch between a switch
    // clearing the transcript and the refetch landing. Writing it through would
    // empty the entry at the one moment it is about to be read, which is the
    // bug with an extra step.
    api.remember('run-a', reading(44_000, 1_000_000));
    api.remember('run-a', null);

    expect(api.recall('run-a')).toEqual(reading(44_000, 1_000_000));
  });

  it('keeps a window of null — a count with no denominator is a real reading', () => {
    // The CLI reporting no window is not the same as reporting nothing: the
    // meter shows `ctx 26k` bare in that case, and flattening the two would
    // make the recall claim a fraction nobody measured.
    api.remember('run-a', reading(26_000, null));

    expect(api.recall('run-a')).toEqual(reading(26_000, null));
  });

  it('forgets a run that is gone', () => {
    // A reading outliving the thread it describes is the one way this could
    // start lying — a new run reusing the id is not possible, but a stale entry
    // for a deleted chat is dead weight the delete path owns.
    api.remember('run-a', reading(44_000, 1_000_000));
    api.forget('run-a');

    expect(api.recall('run-a')).toBeNull();
  });

  it('survives a re-render, which is the point of it being a ref', () => {
    // Filing a reading must not re-render the chat screen — the composer's ring
    // is read during the render that needs it. A `useState` map here would
    // commit on every turn's usage line.
    api.remember('run-a', reading(44_000, 1_000_000));
    const before = api.remember;
    act(() => root.render(<Probe />));

    expect(api.recall('run-a')).toEqual(reading(44_000, 1_000_000));
    // Stable identities, so an effect depending on them does not re-fire.
    expect(api.remember).toBe(before);
  });
});
