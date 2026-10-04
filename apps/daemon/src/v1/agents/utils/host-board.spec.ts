import { describe, expect, it } from 'vitest';

import { HOST_BOARD_TOOLS } from '../chat.types';
import { isHostBoardCall, isHostBoardTool } from './host-board';

const SERVER = 'geniro-75a31aea';

describe('isHostBoardCall — the board tools auto-approve on this run’s server', () => {
  it('matches every board tool in both spellings the shipped CLIs send', () => {
    for (const tool of HOST_BOARD_TOOLS) {
      expect(isHostBoardCall(SERVER, `mcp__${SERVER}__${tool}`), tool).toBe(
        true,
      );
      expect(isHostBoardCall(SERVER, `${SERVER}-${tool}: ${tool}`), tool).toBe(
        true,
      );
    }
  });

  it('refuses another server’s tool of the same name, and a turn granted no server', () => {
    expect(isHostBoardCall(SERVER, 'mcp__linear__create_task')).toBe(false);
    expect(isHostBoardCall(null, `mcp__${SERVER}__create_task`)).toBe(false);
  });

  it('refuses a non-board host tool', () => {
    expect(isHostBoardCall(SERVER, `mcp__${SERVER}__call_agent`)).toBe(false);
  });
});

describe('isHostBoardTool', () => {
  it('names exactly the board tools', () => {
    expect(isHostBoardTool('create_task')).toBe(true);
    expect(isHostBoardTool('delete_task')).toBe(false);
  });
});
