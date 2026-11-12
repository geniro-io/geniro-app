import { describe, expect, it } from 'vitest';

import {
  browserWindowHash,
  parseBrowserWindowHash,
} from './browser-window-route';

describe('browser window route', () => {
  it('reads back the run and a title with spaces, slashes and ampersands', () => {
    const route = { runId: 'run-1', title: 'Fix the build / CI & lint' };

    expect(parseBrowserWindowHash(`#${browserWindowHash(route)}`)).toEqual(
      route,
    );
  });

  it('is not the browser window for an app route or a hash with no run', () => {
    expect(parseBrowserWindowHash('#chats/run-1')).toBeNull();
    expect(parseBrowserWindowHash('#browser-window?title=x')).toBeNull();
    expect(parseBrowserWindowHash('')).toBeNull();
  });
});
