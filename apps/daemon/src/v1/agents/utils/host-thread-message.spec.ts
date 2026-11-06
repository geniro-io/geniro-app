import type { EntityManager } from '@mikro-orm/sqlite';
import { describe, expect, it, vi } from 'vitest';

import type { RunDao } from '../dao/run.dao';
import { threadCardFields } from './host-thread-message';

const SERVER = 'geniro-75a31aea';
const MESSAGE_CALL = `mcp__${SERVER}__message_thread`;
const EM = {} as EntityManager;

describe('threadCardFields — the title a message card names', () => {
  it.each([
    [
      'names the target thread by its title',
      MESSAGE_CALL,
      { thread: 'run-7', message: 'hi' },
      () => Promise.resolve({ title: 'Pelican' }),
      { threadTitle: 'Pelican' },
    ],
    [
      'names a thread with no title as an untitled one',
      MESSAGE_CALL,
      { thread: 'run-7', message: 'hi' },
      () => Promise.resolve({ title: null }),
      { threadTitle: 'Untitled thread' },
    ],
    [
      'names nothing for an input that names no thread',
      MESSAGE_CALL,
      { message: 'hi' },
      () => Promise.resolve({ title: 'Pelican' }),
      {},
    ],
    [
      'names nothing for a thread the database does not hold',
      MESSAGE_CALL,
      { thread: 'run-7', message: 'hi' },
      () => Promise.resolve(null),
      {},
    ],
    [
      'names nothing when the read fails, rather than refusing the call',
      MESSAGE_CALL,
      { thread: 'run-7', message: 'hi' },
      () => Promise.reject(new Error('database is closed')),
      {},
    ],
    [
      'names nothing for another tool',
      `mcp__${SERVER}__notify_user`,
      { thread: 'run-7', message: 'hi' },
      () => Promise.resolve({ title: 'Pelican' }),
      {},
    ],
  ])('%s', async (_label, toolName, input, lookup, expected) => {
    const runDao = { getById: vi.fn(lookup) } as unknown as RunDao;

    await expect(
      threadCardFields(runDao, EM, SERVER, toolName, input),
    ).resolves.toEqual(expected);
  });
});
