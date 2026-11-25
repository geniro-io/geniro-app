import { describe, expect, it } from 'vitest';

import type { Run } from '../../runs/entity/run.entity';
import {
  assertChatRun,
  assertTeamRun,
  chatTeamIdOf,
  isChatTeamId,
  isChatTeamRun,
  librarySlugOf,
} from './run-kind';

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

describe('chat team ids', () => {
  it('names a chat team by its run, in a form no library slug can take', () => {
    expect(chatTeamIdOf('r1')).toBe('chat:r1');
    expect(isChatTeamId(chatTeamIdOf('r9'))).toBe(true);
    expect(isChatTeamId('chat:x')).toBe(true);
    expect(isChatTeamId('my-team')).toBe(false);
    expect(isChatTeamId(null)).toBe(false);
  });

  it('files a chat team under no library slug, and a library team under its own', () => {
    expect(librarySlugOf('chat:x')).toBeNull();
    expect(librarySlugOf(null)).toBeNull();
    expect(librarySlugOf('my-team')).toBe('my-team');
  });

  it('tells a chat team run by its origin alone', () => {
    expect(isChatTeamRun({ teamOrigin: 'chat' })).toBe(true);
    expect(isChatTeamRun({ teamOrigin: null })).toBe(false);
  });
});
