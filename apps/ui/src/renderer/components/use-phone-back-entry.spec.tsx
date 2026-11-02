// @vitest-environment jsdom
import { act, StrictMode, useEffect } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { afterPopstate } from '../__tests__/after-popstate';
import { usePhoneBackEntry } from './use-phone-back-entry';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let back: () => void = () => undefined;

function Probe({
  owner = 'chats',
  open,
  onBack,
}: {
  owner?: string;
  open: boolean;
  onBack: () => void;
}): null {
  back = usePhoneBackEntry(owner, open, onBack);
  return null;
}

/** Renders, then lets the deferred push run. */
async function draw(
  open: boolean,
  onBack: () => void,
  { strict = false, owner = 'chats' } = {},
): Promise<void> {
  const probe = <Probe owner={owner} open={open} onBack={onBack} />;
  await act(async () => {
    root.render(strict ? <StrictMode>{probe}</StrictMode> : probe);
  });
}

/** What iOS's edge swipe / Android's back does: a real traversal. */
const systemBack = (): Promise<void> =>
  afterPopstate(() => history.back(), 'the platform back');

beforeEach(() => {
  // jsdom keeps one history across the file: start each case on an entry no
  // earlier case marked, or it would be adopted.
  history.replaceState(null, '');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe('usePhoneBackEntry', () => {
  it('pushes ONE history entry for an opening, even when StrictMode runs the effect twice', async () => {
    const push = vi.spyOn(history, 'pushState');
    await draw(true, vi.fn(), { strict: true });

    expect(push).toHaveBeenCalledTimes(1);
  });

  it('pushes AFTER the rest of the commit’s effects, so the entry underneath carries what they wrote', async () => {
    // The shell's hash write for a view switch is a later effect in the same
    // flush as the page opening — stood in for by a later sibling's effect.
    const order: string[] = [];
    vi.spyOn(history, 'pushState').mockImplementation(() => {
      order.push('push');
    });
    await act(async () => {
      root.render(
        <>
          <Probe open onBack={vi.fn()} />
          <HashWrite onWrite={() => order.push('hash write')} />
        </>,
      );
    });

    expect(order).toEqual(['hash write', 'push']);
  });

  it('pushes nothing for a page that closed again before the deferred push ran', async () => {
    const push = vi.spyOn(history, 'pushState');
    const onBack = vi.fn();
    await act(async () => {
      flushSync(() => root.render(<Probe open onBack={onBack} />));
      flushSync(() => root.render(<Probe open={false} onBack={onBack} />));
    });

    expect(push).not.toHaveBeenCalled();
  });

  it('keeps a page’s entry when a page stacked on it pops, so the next back closes it', async () => {
    const closeTeam = vi.fn();
    const closeMember = vi.fn();
    function Stack({ member }: { member: boolean }): null {
      usePhoneBackEntry('team', true, closeTeam);
      usePhoneBackEntry('team-member', member, closeMember);
      return null;
    }
    await act(async () => {
      root.render(<Stack member={false} />);
    });
    await act(async () => {
      root.render(<Stack member />);
    });

    await systemBack();
    expect(closeMember).toHaveBeenCalledTimes(1);
    expect(closeTeam).not.toHaveBeenCalled();
    await act(async () => {
      root.render(<Stack member={false} />);
    });

    await systemBack();
    expect(closeTeam).toHaveBeenCalledTimes(1);
  });

  it('adopts both entries of a stack closed by a tab switch, so every later back closes one page', async () => {
    const push = vi.spyOn(history, 'pushState');
    const closeTeam = vi.fn();
    const closeMember = vi.fn();
    function Stack({ active }: { active: boolean }): null {
      usePhoneBackEntry('team', active, closeTeam, {
        stackedOwners: ['team-member'],
      });
      usePhoneBackEntry('team-member', active, closeMember);
      return null;
    }
    await act(async () => {
      root.render(<Stack active />);
    });
    await act(async () => {
      root.render(<Stack active={false} />);
    });
    await act(async () => {
      root.render(<Stack active />);
    });

    expect(push).toHaveBeenCalledTimes(2);
    await systemBack();
    expect(closeMember).toHaveBeenCalledTimes(1);
    expect(closeTeam).not.toHaveBeenCalled();
    await systemBack();
    expect(closeTeam).toHaveBeenCalledTimes(1);
  });

  it('takes the platform back past the entry of a stacked page that closed itself, closing the page under it', async () => {
    // The member removed from its own sheet: the sheet closes without a pop.
    const closeTeam = vi.fn();
    function Stack({ member }: { member: boolean }): null {
      usePhoneBackEntry('team', true, closeTeam, {
        stackedOwners: ['team-member'],
      });
      usePhoneBackEntry('team-member', member, vi.fn());
      return null;
    }
    await act(async () => {
      root.render(<Stack member />);
    });
    await act(async () => {
      root.render(<Stack member={false} />);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await systemBack();
    await act(async () => {
      await vi.waitFor(() => expect(closeTeam).toHaveBeenCalledTimes(1));
    });
    expect(
      (history.state as Record<string, unknown> | null)?.geniroPhonePage,
    ).toBeUndefined();
  });

  describe('when a stacked page closed by a tab switch does not come back', () => {
    const closeTeam = vi.fn();
    let teamBack: () => void = () => undefined;
    function Stack({
      active,
      member,
    }: {
      active: boolean;
      member: boolean;
    }): null {
      teamBack = usePhoneBackEntry('team', active, closeTeam, {
        stackedOwners: ['team-member'],
      });
      usePhoneBackEntry('team-member', active && member, vi.fn());
      return null;
    }
    const pageOfEntry = (): unknown =>
      (history.state as Record<string, unknown> | null)?.geniroPhonePage;

    beforeEach(async () => {
      closeTeam.mockReset();
      await act(async () => {
        root.render(<Stack active member />);
      });
      await act(async () => {
        root.render(<Stack active={false} member />);
      });
      await act(async () => {
        root.render(<Stack active member={false} />);
      });
    });

    it('takes the platform back past the entry left on top, closing the team', async () => {
      await systemBack();
      await act(async () => {
        await vi.waitFor(() => expect(closeTeam).toHaveBeenCalledTimes(1));
      });

      expect(pageOfEntry()).toBeUndefined();
    });

    it('takes the team’s own Back past the entry left on top, in one pop', async () => {
      await afterPopstate(() => teamBack(), '‹ Back');

      expect(closeTeam).toHaveBeenCalledTimes(1);
      expect(pageOfEntry()).toBeUndefined();
    });
  });

  it('runs onBack once when the platform pops that entry, and not for the next pop', async () => {
    const onBack = vi.fn();
    await draw(true, onBack);

    await systemBack();
    expect(onBack).toHaveBeenCalledTimes(1);

    act(() => {
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('does not read a navigation that ADDS an entry — a link pasted into the tab — as back', async () => {
    const onBack = vi.fn();
    await draw(true, onBack);

    act(() => {
      history.pushState(null, '', '#/settings');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });

    expect(onBack).not.toHaveBeenCalled();
  });

  it('routes the page’s own Back through history, so it pops the entry rather than leaving it behind', async () => {
    const onBack = vi.fn();
    await draw(true, onBack);

    await afterPopstate(() => back(), '‹ Back');

    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('pops ONCE for a double press, while the first pop is still on its way', async () => {
    const historyBack = vi.spyOn(history, 'back');
    const onBack = vi.fn();
    await draw(true, onBack);

    await afterPopstate(() => {
      back();
      back();
    }, 'a double ‹ Back');

    expect(historyBack).toHaveBeenCalledTimes(1);
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('runs onBack directly when no entry is held', async () => {
    const historyBack = vi.spyOn(history, 'back');
    const onBack = vi.fn();
    await draw(false, onBack);

    act(() => back());

    expect(historyBack).not.toHaveBeenCalled();
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('ADOPTS its own entry when the page reopens on it, so back still works and nothing piles up', async () => {
    // Closed some other way (a tab switch, a rotation), then opened again
    // while still standing on the entry it pushed.
    const push = vi.spyOn(history, 'pushState');
    const onBack = vi.fn();
    await draw(true, onBack);
    await draw(false, onBack);
    await draw(true, onBack);

    expect(push).toHaveBeenCalledTimes(1);
    await systemBack();
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('works where `crypto.randomUUID` does not exist — the phone’s plain-http LAN page', async () => {
    vi.spyOn(crypto, 'randomUUID').mockImplementation(() => {
      throw new TypeError('crypto.randomUUID is not a function');
    });
    const push = vi.spyOn(history, 'pushState');
    const onBack = vi.fn();
    await draw(true, onBack);

    expect(push).toHaveBeenCalledTimes(1);
    await systemBack();
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('never adopts an entry another kind of page pushed', async () => {
    // The composer's entry is current when a jump opens a Settings section.
    const push = vi.spyOn(history, 'pushState');
    await draw(true, vi.fn(), { owner: 'chats' });
    await draw(false, vi.fn(), { owner: 'chats' });
    const onBack = vi.fn();
    await draw(true, onBack, { owner: 'settings' });

    expect(push).toHaveBeenCalledTimes(2);
    await systemBack();
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});

/** A later sibling whose effect stands in for the shell's hash write. */
function HashWrite({ onWrite }: { onWrite: () => void }): null {
  useEffect(() => {
    onWrite();
  }, [onWrite]);
  return null;
}
