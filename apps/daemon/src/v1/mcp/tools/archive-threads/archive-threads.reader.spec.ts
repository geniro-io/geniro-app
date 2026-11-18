import { describe, expect, it, vi } from 'vitest';

import {
  type ArchiveThreadsAnswer,
  type CommandCenterOps,
  HOST_ARCHIVE_THREADS_TOOL,
  TELL_THREADS_MAX_TARGETS,
} from '../../../agents/chat.types';
import { CommandCenterBroker } from '../../../agents/services/command-center.broker';
import { CommandCenterOpsBroker } from '../../../agents/services/command-center-ops.broker';
import type { McpCallContext, McpListContext } from '../../mcp.types';
import {
  archiveThreadsResultText,
  readArchiveThreadsArgs,
} from './archive-threads.reader';
import { ArchiveThreadsTool } from './archive-threads.tool';

const LISTING: McpListContext = {
  runId: 'manager-1',
  memberId: 'agent',
  conversationId: null,
};

const CONTEXT = {
  ...LISTING,
  caller: 'agent',
  requestId: 1,
} as McpCallContext;

const ARCHIVED: ArchiveThreadsAnswer = {
  archived: [
    {
      to: 't1',
      handle: 't1',
      runId: 'thread-1',
      title: 'Billing cache',
      outcome: 'archived',
      code: null,
    },
  ],
  unresolved: [],
};

function ops(
  overrides: Partial<CommandCenterOps> = {},
): CommandCenterOpsBroker {
  const broker = new CommandCenterOpsBroker();
  broker.install({
    tell: () => Promise.reject(new Error('unused')),
    note: () => Promise.reject(new Error('unused')),
    start: () => Promise.reject(new Error('unused')),
    archive: () => Promise.resolve(ARCHIVED),
    ...overrides,
  });
  return broker;
}

function textOf(result: { content: { text: string }[] }): string {
  return result.content[0]!.text;
}

describe('readArchiveThreadsArgs', () => {
  it('reads the named threads', () => {
    expect(readArchiveThreadsArgs({ threads: ['t1', 't2'] })).toEqual({
      ok: true,
      query: { threads: ['t1', 't2'] },
    });
  });

  it('refuses no thread, too many threads and an unknown key', () => {
    expect(readArchiveThreadsArgs({ threads: [] }).ok).toBe(false);
    expect(
      readArchiveThreadsArgs({
        threads: Array.from(
          { length: TELL_THREADS_MAX_TARGETS + 1 },
          (_, index) => `t${index + 1}`,
        ),
      }).ok,
    ).toBe(false);
    expect(readArchiveThreadsArgs({ threads: ['t1'], delete: true }).ok).toBe(
      false,
    );
  });
});

describe('archiveThreadsResultText', () => {
  it('says every thread is archived when none was refused', () => {
    expect(archiveThreadsResultText(ARCHIVED)).toBe(
      `${JSON.stringify(ARCHIVED)}\nEvery thread above is archived. Tell the user which ones.`,
    );
  });

  it('says nothing was archived when a name is unresolved', () => {
    const unresolved: ArchiveThreadsAnswer = {
      archived: [],
      unresolved: [
        {
          to: 'billing',
          code: 'AMBIGUOUS_TARGET',
          candidates: [
            { handle: 't1', title: 'Billing cache' },
            { handle: 't2', title: 'Billing invoices' },
          ],
        },
      ],
    };

    expect(archiveThreadsResultText(unresolved)).toContain(
      'Nothing was archived. Ask the user which threads they meant',
    );
  });

  it('names a refused thread instead of saying every thread is archived', () => {
    const mixed: ArchiveThreadsAnswer = {
      archived: [
        ...ARCHIVED.archived,
        {
          to: 't2',
          handle: 't2',
          runId: 'thread-2',
          title: 'B',
          outcome: 'refused',
          code: 'RUN_NOT_FOUND',
        },
      ],
      unresolved: [],
    };

    const text = archiveThreadsResultText(mixed);

    expect(text).toContain('Not archived: t2 (RUN_NOT_FOUND)');
    expect(text).not.toContain('Every thread above is archived');
  });
});

describe('ArchiveThreadsTool', () => {
  it('is listed only to a turn the command center has a sink for', () => {
    const managers = new CommandCenterBroker();

    expect(new ArchiveThreadsTool(managers, ops()).list(LISTING)).toEqual([]);

    managers.register('manager-1', 'agent', { managerRunId: 'manager-1' });

    expect(
      new ArchiveThreadsTool(managers, ops())
        .list(LISTING)
        .map((listed) => listed.name),
    ).toEqual([HOST_ARCHIVE_THREADS_TOOL]);
  });

  it('tells the manager to archive only on the user ask, and that nothing is deleted', () => {
    const managers = new CommandCenterBroker();
    managers.register('manager-1', 'agent', { managerRunId: 'manager-1' });

    const [listed] = new ArchiveThreadsTool(managers, ops()).list(LISTING);

    expect(listed!.description).toContain(
      'ONLY when the user asked, in their own words',
    );
    expect(listed!.description).toContain('It is never deleted.');
  });

  it('hands the manager run and the arguments to the operations, and answers what they archived', async () => {
    const archive = vi.fn(() => Promise.resolve(ARCHIVED));
    const managers = new CommandCenterBroker();
    managers.register('manager-1', 'agent', { managerRunId: 'manager-1' });

    const result = await new ArchiveThreadsTool(
      managers,
      ops({ archive }),
    ).call(HOST_ARCHIVE_THREADS_TOOL, { threads: ['t1'] }, CONTEXT);

    expect(archive).toHaveBeenCalledWith('manager-1', { threads: ['t1'] });
    expect(result.isError).toBe(false);
    expect(textOf(result)).toBe(archiveThreadsResultText(ARCHIVED));
  });

  it('answers a refusal of the operations as an error, with the reason', async () => {
    const result = await new ArchiveThreadsTool(
      new CommandCenterBroker(),
      ops({
        archive: () =>
          Promise.reject(
            new Error('only the command center manager may call this tool'),
          ),
      }),
    ).call(
      HOST_ARCHIVE_THREADS_TOOL,
      { threads: ['t1'] },
      { ...CONTEXT, runId: 'run-2' },
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      'The command center could not answer: only the command center manager may call this tool',
    );
  });

  it('refuses malformed arguments in-protocol, without reaching the operations', async () => {
    const archive = vi.fn(() => Promise.resolve(ARCHIVED));

    const result = await new ArchiveThreadsTool(
      new CommandCenterBroker(),
      ops({ archive }),
    ).call(HOST_ARCHIVE_THREADS_TOOL, { threads: [] }, CONTEXT);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/^INVALID_ARGS: /);
    expect(archive).not.toHaveBeenCalled();
  });
});
