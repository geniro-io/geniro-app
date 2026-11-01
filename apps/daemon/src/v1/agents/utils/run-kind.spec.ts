import { describe, expect, it } from 'vitest';

import type { Run } from '../../runs/entity/run.entity';
import { assertChatRun, assertTeamRun } from './run-kind';

const chatRun = { id: 'r1', teamId: null } as unknown as Run;
const teamRun = { id: 'r2', teamId: 'wf-1' } as unknown as Run;

describe('assertChatRun', () => {
  it('returns a chat run unchanged', () => {
    expect(assertChatRun(chatRun, 'r1')).toBe(chatRun);
  });

  it('404s a missing run', () => {
    expect(() => assertChatRun(null, 'gone')).toThrowError(
      /RUN_NOT_FOUND|not found/,
    );
  });

  it('rejects a team run addressed via a chat endpoint', () => {
    expect(() => assertChatRun(teamRun, 'r2')).toThrowError(
      /NOT_A_CHAT_RUN|not a single-agent chat/,
    );
  });
});

describe('assertTeamRun', () => {
  it('returns a team run unchanged', () => {
    expect(assertTeamRun(teamRun, 'r2')).toBe(teamRun);
  });

  it('404s a missing run', () => {
    expect(() => assertTeamRun(null, 'gone')).toThrowError(
      /RUN_NOT_FOUND|not found/,
    );
  });

  it('rejects a chat run addressed via a team endpoint', () => {
    expect(() => assertTeamRun(chatRun, 'r1')).toThrowError(
      /NOT_A_TEAM_RUN|not a team/,
    );
  });
});
