import { describe, expect, it, vi } from 'vitest';

import { keepWindowUnscrolled } from './keep-window-unscrolled';

const SAFARI = { layout: 777, visual: 777, keyboard: 374 };
const CHROME_IPAD = { layout: 892, visual: 808, keyboard: 323 };

function fakeWindow({ layout, visual }: { layout: number; visual: number }) {
  const visualViewport = Object.assign(new EventTarget(), {
    width: 1366,
    height: visual,
    scale: 1,
  });
  const win = Object.assign(new EventTarget(), {
    visualViewport,
    document: { documentElement: { clientWidth: 1366, clientHeight: layout } },
    innerHeight: visual,
    scrollX: 0,
    scrollY: 0,
    scrollTo: vi.fn(() => {
      win.scrollX = 0;
      win.scrollY = 0;
    }),
  });
  return win;
}

type FakeWindow = ReturnType<typeof fakeWindow>;

function install(win: FakeWindow) {
  return keepWindowUnscrolled(win as unknown as Window);
}

function scrollTo(win: FakeWindow, y: number) {
  win.scrollY = y;
  win.dispatchEvent(new Event('scroll'));
}

function resizeViewport(win: FakeWindow, height: number) {
  win.visualViewport.height = height;
  win.visualViewport.dispatchEvent(new Event('resize'));
}

describe('keepWindowUnscrolled', () => {
  it('scrolls the window back once the keyboard has closed and left it lifted', () => {
    const win = fakeWindow(SAFARI);
    install(win);

    scrollTo(win, 62);

    expect(win.scrollTo).toHaveBeenCalledWith(0, 0);
    expect(win.scrollY).toBe(0);
  });

  it('puts the page back when Chrome on iPad lifts it with no keyboard, though its visual viewport is shorter than the layout one', () => {
    const win = fakeWindow(CHROME_IPAD);
    install(win);

    scrollTo(win, 84);

    expect(win.scrollTo).toHaveBeenCalledWith(0, 0);
    expect(win.scrollY).toBe(0);
  });

  it('settles when the visual viewport grows back to its full height', () => {
    for (const browser of [SAFARI, CHROME_IPAD]) {
      const win = fakeWindow(browser);
      install(win);
      resizeViewport(win, browser.keyboard);
      win.scrollY = 298;

      resizeViewport(win, browser.visual);

      expect(win.scrollTo).toHaveBeenCalledWith(0, 0);
    }
  });

  it('leaves the lift alone while the keyboard is up, even when innerHeight shrinks with it', () => {
    for (const browser of [SAFARI, CHROME_IPAD]) {
      const win = fakeWindow(browser);
      install(win);

      win.innerHeight = browser.keyboard;
      resizeViewport(win, browser.keyboard);
      scrollTo(win, 298);

      expect(win.scrollTo).not.toHaveBeenCalled();
    }
  });

  it('leaves the lift alone under the hardware keyboard bar, a drop far smaller than Chrome’s gap', () => {
    const win = fakeWindow({ layout: 1078, visual: 1078 });
    install(win);

    resizeViewport(win, 1007);
    scrollTo(win, 40);

    expect(win.scrollTo).not.toHaveBeenCalled();
  });

  it('leaves a pinch-zoomed page where the user put it', () => {
    const win = fakeWindow(SAFARI);
    install(win);

    win.visualViewport.scale = 2;
    scrollTo(win, 120);

    expect(win.scrollTo).not.toHaveBeenCalled();
  });

  it('measures the full height again after the layout width changes', () => {
    const win = fakeWindow(CHROME_IPAD);
    install(win);

    win.document.documentElement.clientWidth = 1024;
    win.visualViewport.height = 1150;
    resizeViewport(win, 1150);
    resizeViewport(win, 1066);
    scrollTo(win, 84);
    expect(win.scrollTo).not.toHaveBeenCalled();

    win.document.documentElement.clientWidth = 1366;
    resizeViewport(win, CHROME_IPAD.visual);
    scrollTo(win, 84);
    expect(win.scrollTo).toHaveBeenCalledWith(0, 0);
  });

  it('does nothing when the window is not scrolled', () => {
    const win = fakeWindow(SAFARI);
    install(win);

    win.dispatchEvent(new Event('scroll'));
    resizeViewport(win, SAFARI.visual);

    expect(win.scrollTo).not.toHaveBeenCalled();
  });

  it('still settles in a browser without a visual viewport', () => {
    const win = fakeWindow(SAFARI);
    Reflect.deleteProperty(win, 'visualViewport');
    install(win);

    scrollTo(win, 62);

    expect(win.scrollTo).toHaveBeenCalledWith(0, 0);
  });

  it('stops listening once disposed', () => {
    const win = fakeWindow(SAFARI);
    const dispose = install(win);
    dispose();

    scrollTo(win, 62);

    expect(win.scrollTo).not.toHaveBeenCalled();
  });
});
