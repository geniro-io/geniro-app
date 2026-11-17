import { describe, expect, it } from 'vitest';

import {
  isCommandCenterChat,
  isHostCommandCenterMessageCall,
} from './host-command-center';

const SERVER = 'geniro-75a31aea';

describe('isHostCommandCenterMessageCall', () => {
  it('matches tell_threads and note_thread on this run’s server, in both spellings', () => {
    for (const tool of ['tell_threads', 'note_thread']) {
      expect(
        isHostCommandCenterMessageCall(SERVER, `mcp__${SERVER}__${tool}`),
      ).toBe(true);
      expect(
        isHostCommandCenterMessageCall(SERVER, `${SERVER}-${tool}: ${tool}`),
      ).toBe(true);
    }
  });

  it('refuses start_thread, message_thread, another server and no server', () => {
    expect(
      isHostCommandCenterMessageCall(SERVER, `mcp__${SERVER}__start_thread`),
    ).toBe(false);
    expect(
      isHostCommandCenterMessageCall(SERVER, `mcp__${SERVER}__message_thread`),
    ).toBe(false);
    expect(
      isHostCommandCenterMessageCall(SERVER, 'mcp__other__tell_threads'),
    ).toBe(false);
    expect(
      isHostCommandCenterMessageCall(null, `mcp__${SERVER}__tell_threads`),
    ).toBe(false);
  });
});

describe('isCommandCenterChat', () => {
  it('is true only on a run marked as the manager', () => {
    expect(isCommandCenterChat({ commandCenter: true })).toBe(true);
    expect(isCommandCenterChat({ commandCenter: null })).toBe(false);
  });
});
