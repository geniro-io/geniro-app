// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ThreadFace, type ThreadFaceLook } from './thread-face';

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

function faceOf(look: ThreadFaceLook): HTMLElement {
  act(() => root.render(<ThreadFace look={look} slot="thread-face" />));
  const face = container.querySelector<HTMLElement>(
    '[data-slot="thread-face"]',
  );
  if (face === null) {
    throw new Error('the face rendered nothing');
  }
  return face;
}

describe('ThreadFace', () => {
  it('draws a member as the member avatar, named by its title', () => {
    const face = faceOf({
      kind: 'member',
      name: 'Senior Engineer',
      avatar: { kind: 'initials', value: 'SE' },
      colorKey: 'senior',
    });

    expect(face.dataset.face).toBe('member');
    expect(face.title).toBe('Senior Engineer');
    expect(face.textContent).toBe('SE');
  });

  it('draws a monitor as a glyph in a muted circle', () => {
    const face = faceOf({ kind: 'monitor' });

    expect(face.dataset.face).toBe('monitor');
    expect(face.className).toContain('bg-muted');
    expect(face.querySelector('svg')).not.toBeNull();
  });
});
