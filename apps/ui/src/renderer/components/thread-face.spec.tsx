// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ThreadFace,
  type ThreadFaceLook,
  type ThreadFaceSize,
} from './thread-face';

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

function faceOf(look: ThreadFaceLook, size?: ThreadFaceSize): HTMLElement {
  act(() =>
    root.render(<ThreadFace look={look} slot="thread-face" size={size} />),
  );
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

  it('draws the default face at size md', () => {
    expect(faceOf({ kind: 'monitor' }).dataset.size).toBe('md');
  });

  it('draws a member at size sm as a 24px face', () => {
    const face = faceOf(
      {
        kind: 'member',
        name: 'Senior Engineer',
        avatar: { kind: 'initials', value: 'SE' },
        colorKey: 'senior',
      },
      'sm',
    );

    expect(face.dataset.size).toBe('sm');
    expect(face.className).toContain('size-6');
    expect(face.className).not.toContain('size-8');
  });

  it('draws an agent at size sm with the glyph its siblings draw at sm', () => {
    const agent = faceOf({ kind: 'agent', icon: 'bot', name: 'claude' }, 'sm');
    expect(agent.dataset.face).toBe('agent');
    const agentGlyph = agent.querySelector('svg')?.getAttribute('class');

    const monitor = faceOf({ kind: 'monitor' }, 'sm');
    const monitorGlyph = monitor.querySelector('svg')?.getAttribute('class');

    expect(agentGlyph).toContain('size-3.5');
    expect(agentGlyph).not.toContain('size-4');
    expect(monitorGlyph).toContain('size-3.5');
  });

  it('draws a team at size sm in a 24px row', () => {
    const face = faceOf(
      {
        kind: 'team',
        total: 3,
        people: [
          { key: 'lead', name: 'Lead' },
          { key: 'senior', name: 'Senior Engineer' },
        ],
      },
      'sm',
    );

    expect(face.dataset.face).toBe('team');
    expect(face.dataset.size).toBe('sm');
    expect(face.className).toContain('h-6');
  });

  it('draws a monitor as a glyph in a muted circle', () => {
    const face = faceOf({ kind: 'monitor' });

    expect(face.dataset.face).toBe('monitor');
    expect(face.className).toContain('bg-muted');
    expect(face.querySelector('svg')).not.toBeNull();
  });
});
