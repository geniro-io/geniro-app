// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AccountButton } from './account-button';

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
});

function render(
  props: Partial<React.ComponentProps<typeof AccountButton>> = {},
): HTMLButtonElement | null {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <AccountButton
        loggedIn={null}
        signingIn={false}
        onSignIn={vi.fn()}
        onSignOut={vi.fn()}
        {...props}
      />,
    );
  });
  return container.querySelector('button');
}

describe('AccountButton', () => {
  it('offers Sign out only for an account the CLI says is signed in', () => {
    expect(render({ loggedIn: true })?.textContent).toBe('Sign out');
    act(() => root?.unmount());
    expect(render({ loggedIn: false })?.textContent).toBe('Sign in');
    act(() => root?.unmount());
    expect(render({ loggedIn: null })?.textContent).toBe('Sign in');
  });

  it('draws nothing rather than the other verb when its own has no handler', () => {
    expect(render({ loggedIn: true, onSignOut: undefined })).toBeNull();
    act(() => root?.unmount());
    expect(render({ loggedIn: false, onSignIn: undefined })).toBeNull();
  });

  it('spins and refuses a second press while its sign-in is being asked for', () => {
    const onSignIn = vi.fn();
    const button = render({ signingIn: true, onSignIn })!;
    expect(button.textContent).toBe('Signing in…');
    expect(button.disabled).toBe(true);
    act(() => button.click());
    expect(onSignIn).not.toHaveBeenCalled();
  });

  it('withholds both verbs while ANOTHER sign-in owns the browser', () => {
    expect(render({ busy: true })!.disabled).toBe(true);
    act(() => root?.unmount());
    expect(render({ busy: true, loggedIn: true })!.disabled).toBe(true);
  });

  it('names the account it acts on when several sit together', () => {
    expect(render({ account: 'work' })!.getAttribute('aria-label')).toBe(
      'Sign in to work',
    );
    act(() => root?.unmount());
    expect(
      render({ account: 'work', loggedIn: true })!.getAttribute('aria-label'),
    ).toBe('Sign out of work');
  });
});
