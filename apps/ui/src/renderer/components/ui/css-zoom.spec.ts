// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

import { stubCssZoom } from '../../__tests__/stub-css-zoom';
import { counterZoomOf, counterZoomStyle } from './css-zoom';

let restore: (() => void) | null = null;

afterEach(() => {
  restore?.();
  restore = null;
});

describe('counterZoomOf', () => {
  it('undoes the zoom above an element', () => {
    restore = stubCssZoom(0.5);
    expect(counterZoomOf(document.createElement('div'))).toBe(2);
    expect(counterZoomStyle(document.createElement('div'))).toEqual({
      zoom: 2,
    });
  });

  it('is nothing where nothing is zoomed, or the browser reports no zoom', () => {
    restore = stubCssZoom(1);
    expect(counterZoomOf(document.createElement('div'))).toBeUndefined();
    restore();
    restore = null;
    expect(counterZoomOf(document.createElement('div'))).toBeUndefined();
    expect(counterZoomOf(null)).toBeUndefined();
    expect(counterZoomStyle(null)).toEqual({});
  });
});
