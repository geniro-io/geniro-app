// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AvatarImageLoaderContext } from './avatar-images';
import { AvatarStack, initialsOf, MemberAvatar } from './member-avatar';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

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

const avatar = (): HTMLElement =>
  container.querySelector<HTMLElement>('[data-slot="avatar"]')!;

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

describe('initialsOf', () => {
  it('takes the first letters of up to two words', () => {
    expect(initialsOf('Poet')).toBe('P');
    expect(initialsOf('Flaky (cursor)')).toBe('FC');
    expect(initialsOf('deep research helper')).toBe('DR');
    expect(initialsOf('')).toBe('?');
  });
});

describe('MemberAvatar', () => {
  it('draws initials on the same tone for the same member every time', () => {
    act(() => root.render(<MemberAvatar name="Ada" colorKey="ada" />));
    const tone = avatar().className;
    expect(avatar().textContent).toBe('A');

    act(() => root.render(<MemberAvatar name="Ada renamed" colorKey="ada" />));
    expect(avatar().className).toBe(tone);
    expect(avatar().textContent).toBe('AR');
  });

  it('renders emoji on the chosen tone', () => {
    act(() =>
      root.render(
        <MemberAvatar
          name="Ada"
          avatar={{ kind: 'emoji', value: '🦊', tone: 'avatar-5' }}
        />,
      ),
    );
    expect(avatar().dataset.avatarKind).toBe('emoji');
    expect(avatar().textContent).toBe('🦊');
    expect(avatar().className).toContain('bg-avatar-5');
  });

  it('draws the initials the member typed, not ones derived from the name', () => {
    act(() =>
      root.render(
        <MemberAvatar
          name="Grace Hopper"
          avatar={{ kind: 'initials', value: 'gh2', tone: 'avatar-2' }}
        />,
      ),
    );
    expect(avatar().textContent).toBe('GH2');
    expect(avatar().className).toContain('bg-avatar-2');
  });

  it('shows the picture the loader reads', async () => {
    const load = vi.fn(async () => 'data:image/png;base64,AAAA');
    act(() =>
      root.render(
        <AvatarImageLoaderContext.Provider value={load}>
          <MemberAvatar
            name="Ada"
            avatar={{ kind: 'picture', value: 'shown.png' }}
          />
        </AvatarImageLoaderContext.Provider>,
      ),
    );
    await flush();
    expect(load).toHaveBeenCalledWith('shown.png');
    expect(avatar().dataset.avatarKind).toBe('picture');
    expect(avatar().querySelector('img')?.getAttribute('src')).toBe(
      'data:image/png;base64,AAAA',
    );
  });

  it('falls back to initials when the picture fails', async () => {
    const load = vi.fn(async () => {
      throw new Error('404');
    });
    act(() =>
      root.render(
        <AvatarImageLoaderContext.Provider value={load}>
          <MemberAvatar
            name="Ada Lovelace"
            avatar={{ kind: 'picture', value: 'gone.png' }}
          />
        </AvatarImageLoaderContext.Provider>,
      ),
    );
    await flush();
    expect(avatar().dataset.avatarKind).toBe('initials');
    expect(avatar().textContent).toBe('AL');
    expect(avatar().querySelector('img')).toBeNull();
  });

  it('asks again on the next mount after a refused read', async () => {
    const load = vi
      .fn<(id: string) => Promise<string>>()
      .mockRejectedValueOnce(new Error('daemon restarting'))
      .mockResolvedValueOnce('data:image/png;base64,BBBB');
    const draw = (): void =>
      act(() =>
        root.render(
          <AvatarImageLoaderContext.Provider value={load}>
            <MemberAvatar
              name="Ada"
              avatar={{ kind: 'picture', value: 'retry.png' }}
            />
          </AvatarImageLoaderContext.Provider>,
        ),
      );
    draw();
    await flush();
    expect(avatar().dataset.avatarKind).toBe('initials');

    act(() => root.render(<span />));
    draw();
    await flush();

    expect(load).toHaveBeenCalledTimes(2);
    expect(avatar().querySelector('img')?.getAttribute('src')).toBe(
      'data:image/png;base64,BBBB',
    );
  });

  it('draws a picture it already read at once, with no initials first', async () => {
    const load = vi.fn(async () => 'data:image/png;base64,CCCC');
    const draw = (): void =>
      act(() =>
        root.render(
          <AvatarImageLoaderContext.Provider value={load}>
            <MemberAvatar
              name="Ada"
              avatar={{ kind: 'picture', value: 'seen.png' }}
            />
          </AvatarImageLoaderContext.Provider>,
        ),
      );
    draw();
    await flush();
    act(() => root.render(<span />));

    draw();

    expect(avatar().dataset.avatarKind).toBe('picture');
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('falls back to initials when the read picture cannot be decoded', async () => {
    const load = vi.fn(async () => 'data:image/png;base64,broken');
    act(() =>
      root.render(
        <AvatarImageLoaderContext.Provider value={load}>
          <MemberAvatar
            name="Ada"
            avatar={{ kind: 'picture', value: 'broken.png' }}
          />
        </AvatarImageLoaderContext.Provider>,
      ),
    );
    await flush();
    const image = avatar().querySelector('img')!;
    act(() => {
      image.dispatchEvent(new Event('error'));
    });
    expect(avatar().dataset.avatarKind).toBe('initials');
    expect(avatar().textContent).toBe('A');
  });

  it('draws the user as a glyph, never as a letter', () => {
    act(() => root.render(<MemberAvatar name="You" solid />));
    expect(avatar().className).toContain('bg-avatar-user');
    expect(avatar().querySelector('svg')).not.toBeNull();
    expect(avatar().textContent).toBe('');
  });

  it('is announced by name only when labelled', () => {
    act(() => root.render(<MemberAvatar name="Ada" />));
    expect(avatar().getAttribute('aria-hidden')).toBe('true');
    act(() => root.render(<MemberAvatar name="Ada" labelled />));
    expect(avatar().getAttribute('role')).toBe('img');
    expect(avatar().getAttribute('aria-label')).toBe('Ada');
  });
});

describe('AvatarStack', () => {
  const people = ['Ada', 'Linus', 'Grace', 'Margaret', 'Alan', 'Barbara'].map(
    (name) => ({ key: name.toLowerCase(), name }),
  );

  it('shows the first few faces, then how many more there are', () => {
    act(() => root.render(<AvatarStack people={people} max={3} total={9} />));
    expect(container.querySelectorAll('[data-slot="avatar"]').length).toBe(3);
    expect(
      container.querySelector('[data-slot="avatar-stack-rest"]')?.textContent,
    ).toBe('+6');
  });

  it('draws no counter when everyone fits', () => {
    act(() => root.render(<AvatarStack people={people.slice(0, 2)} />));
    expect(
      container.querySelector('[data-slot="avatar-stack-rest"]'),
    ).toBeNull();
  });
});
