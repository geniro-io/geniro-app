// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

import { isInModalAbove } from './modal-above';

function modal(): HTMLElement {
  const element = document.createElement('div');
  element.setAttribute('role', 'dialog');
  element.setAttribute('aria-modal', 'true');
  document.body.appendChild(element);
  return element;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('isInModalAbove', () => {
  it('is true for a node in a modal dialog that does not hold the panel', () => {
    const panel = document.body.appendChild(document.createElement('div'));
    const field = modal().appendChild(document.createElement('input'));

    expect(isInModalAbove(panel, field)).toBe(true);
  });

  it('is false for a node in the modal dialog the panel itself sits in', () => {
    const outer = modal();
    const panel = outer.appendChild(document.createElement('div'));
    const field = outer.appendChild(document.createElement('input'));

    expect(isInModalAbove(panel, field)).toBe(false);
  });

  it('is false for a node in no modal dialog, or in a non-modal one', () => {
    const panel = document.body.appendChild(document.createElement('div'));
    const plain = document.body.appendChild(document.createElement('button'));
    const nonModal = document.body.appendChild(document.createElement('div'));
    nonModal.setAttribute('role', 'dialog');
    const inside = nonModal.appendChild(document.createTextNode('text'));

    expect(isInModalAbove(panel, plain)).toBe(false);
    expect(isInModalAbove(panel, inside)).toBe(false);
  });
});
