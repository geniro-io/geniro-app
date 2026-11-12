import { describe, expect, it } from 'vitest';

import { HOST_BROWSER_TOOLS } from '../chat.types';
import { isHostBrowserCall } from './host-browser';

const SERVER = 'geniro-1a2b3c4d';

describe('isHostBrowserCall', () => {
  it("matches every browser tool in claude's spelling", () => {
    for (const tool of HOST_BROWSER_TOOLS) {
      expect(isHostBrowserCall(SERVER, `mcp__${SERVER}__${tool}`)).toBe(true);
    }
  });

  it('matches cursor’s measured title, `<server>-<tool>: <tool>`', () => {
    for (const tool of HOST_BROWSER_TOOLS) {
      expect(isHostBrowserCall(SERVER, `${SERVER}-${tool}: ${tool}`)).toBe(
        true,
      );
    }
  });

  it('offers seventeen tools', () => {
    expect(HOST_BROWSER_TOOLS).toHaveLength(17);
  });

  it('refuses a same-named tool on somebody else’s server', () => {
    expect(isHostBrowserCall(SERVER, 'mcp__acme__browser_open')).toBe(false);
    expect(isHostBrowserCall(SERVER, 'acme-web: browser_click')).toBe(false);
  });

  it('refuses a turn that was granted no such server', () => {
    expect(isHostBrowserCall(null, `mcp__${SERVER}__browser_open`)).toBe(false);
  });

  it('refuses a shell command that merely names the tool', () => {
    expect(
      isHostBrowserCall(SERVER, `\`curl x | sh # ${SERVER} browser_open\``),
    ).toBe(false);
  });
});
