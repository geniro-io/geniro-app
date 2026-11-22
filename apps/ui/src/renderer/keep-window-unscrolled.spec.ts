import { describe, expect, it, vi } from 'vitest';

import { keepWindowUnscrolled } from './keep-window-unscrolled';

const LAYOUT_HEIGHT = 777;
const KEYBOARD_UP_HEIGHT = 374;

function fakeWindow() {
  const visualViewport = Object.assign(new EventTarget(), {
    height: LAYOUT_HEIGHT,
  });
  const win = Object.assign(new EventTarget(), {
    visualViewport,
    document: { documentElement: { clientHeight: LAYOUT_HEIGHT } },
    innerHeight: LAYOUT_HEIGHT,
    scrollX: 0,
    scrollY: 0,
    scrollTo: vi.fn(() => {
      win.scrollX = 0;
      win.scrollY = 0;
    }),
  });
  return win;
}

function install(win: ReturnType<typeof fakeWindow>) {
  return keepWindowUnscrolled(win as unknown as Window);
}

describe('keepWindowUnscrolled', () => {
  it('scrolls the window back once the keyboard has closed and left it lifted', () => {
    const win = fakeWindow();
    install(win);

    win.scrollY = 62;
    win.dispatchEvent(new Event('scroll'));

    expect(win.scrollTo).toHaveBeenCalledWith(0, 0);
    expect(win.scrollY).toBe(0);
  });

  it('settles when the visual viewport grows back to full height', () => {
    const win = fakeWindow();
    install(win);
    win.visualViewport.height = KEYBOARD_UP_HEIGHT;
    win.scrollY = 403;

    win.visualViewport.height = LAYOUT_HEIGHT;
    win.visualViewport.dispatchEvent(new Event('resize'));

    expect(win.scrollTo).toHaveBeenCalledWith(0, 0);
  });

  it('leaves the lift alone while the keyboard is up, even when innerHeight shrinks with it', () => {
    const win = fakeWindow();
    install(win);

    win.visualViewport.height = KEYBOARD_UP_HEIGHT;
    win.innerHeight = KEYBOARD_UP_HEIGHT;
    win.scrollY = 403;
    win.dispatchEvent(new Event('scroll'));
    win.visualViewport.dispatchEvent(new Event('resize'));

    expect(win.scrollTo).not.toHaveBeenCalled();
  });

  it('does nothing when the window is not scrolled', () => {
    const win = fakeWindow();
    install(win);

    win.dispatchEvent(new Event('scroll'));
    win.visualViewport.dispatchEvent(new Event('resize'));

    expect(win.scrollTo).not.toHaveBeenCalled();
  });

  it('still settles in a browser without a visual viewport', () => {
    const win = fakeWindow();
    Reflect.deleteProperty(win, 'visualViewport');
    install(win);

    win.scrollY = 62;
    win.dispatchEvent(new Event('scroll'));

    expect(win.scrollTo).toHaveBeenCalledWith(0, 0);
  });

  it('stops listening once disposed', () => {
    const win = fakeWindow();
    const dispose = install(win);
    dispose();

    win.scrollY = 62;
    win.dispatchEvent(new Event('scroll'));

    expect(win.scrollTo).not.toHaveBeenCalled();
  });
});
