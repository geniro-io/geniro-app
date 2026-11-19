import { describe, expect, it, vi } from 'vitest';

import {
  type CommandCenterOps,
  HOST_READ_COMMAND_CENTER_TOOL,
  type ReadCommandCenterAnswer,
} from '../../../agents/chat.types';
import { AnalysisBroker } from '../../../agents/services/analysis.broker';
import { CommandCenterBroker } from '../../../agents/services/command-center.broker';
import { CommandCenterOpsBroker } from '../../../agents/services/command-center-ops.broker';
import { ProjectChatBroker } from '../../../agents/services/project-chat.broker';
import { TeamBuilderBroker } from '../../../agents/services/team-builder.broker';
import type { ThreadDeliveryService } from '../../../teams/services/thread-delivery.service';
import type { McpCallContext, McpListContext } from '../../mcp.types';
import { ListThreadsTool } from '../list-threads/list-threads.tool';
import { MessageThreadTool } from '../message-thread/message-thread.tool';
import {
  COMMAND_CENTER_GRAPH_PREFACE,
  readCommandCenterResultText,
  readReadCommandCenterArgs,
} from './read-command-center.reader';
import { ReadCommandCenterTool } from './read-command-center.tool';

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

const GRAPH: ReadCommandCenterAnswer = {
  generatedAt: '2026-11-19T10:00:00.000Z',
  threads: [
    {
      handle: 't1',
      runId: 'run-1',
      title: 'Billing cache',
      project: 'Billing',
      column: 'done',
      status: 'completed',
      awaiting: null,
      awaitingReply: false,
      pullRequest: 42,
      taskCard: null,
      lastActivityAt: '2026-11-19T09:55:00.000Z',
      note: null,
    },
  ],
  pendingStarts: 0,
};

function ops(
  overrides: Partial<CommandCenterOps> = {},
): CommandCenterOpsBroker {
  const broker = new CommandCenterOpsBroker();
  broker.install({
    tell: () => Promise.reject(new Error('unused')),
    note: () => Promise.reject(new Error('unused')),
    start: () => Promise.reject(new Error('unused')),
    archive: () => Promise.reject(new Error('unused')),
    read: () => Promise.resolve(GRAPH),
    ...overrides,
  });
  return broker;
}

function tool(
  managers: CommandCenterBroker,
  commandOps: CommandCenterOpsBroker,
): ReadCommandCenterTool {
  return new ReadCommandCenterTool(managers, commandOps);
}

function textOf(result: { content: { text: string }[] }): string {
  return result.content[0]!.text;
}

function listedNamesFor(
  managers: CommandCenterBroker,
  commandOps: CommandCenterOpsBroker,
): string[] {
  const gates = {
    analysis: new AnalysisBroker(),
    teamBuilders: new TeamBuilderBroker(),
    projectChats: new ProjectChatBroker(),
    commandCenters: managers,
  };
  const threads = {} as ThreadDeliveryService;
  return [
    new ReadCommandCenterTool(managers, commandOps),
    new ListThreadsTool(threads, gates),
    new MessageThreadTool(threads, gates),
  ]
    .flatMap((listed) => listed.list(LISTING))
    .map((listed) => listed.name);
}

describe('readReadCommandCenterArgs', () => {
  it('reads no arguments', () => {
    expect(readReadCommandCenterArgs({})).toEqual({ ok: true, query: {} });
  });

  it('refuses an unknown key', () => {
    expect(readReadCommandCenterArgs({ x: 1 }).ok).toBe(false);
  });
});

describe('readCommandCenterResultText', () => {
  it('prefaces the graph as data and carries it as JSON', () => {
    expect(readCommandCenterResultText(GRAPH)).toBe(
      `${COMMAND_CENTER_GRAPH_PREFACE}\n${JSON.stringify(GRAPH)}`,
    );
  });
});

describe('ReadCommandCenterTool', () => {
  it('is listed only to a turn the command center has a sink for', () => {
    const managers = new CommandCenterBroker();

    expect(tool(managers, ops()).list(LISTING)).toEqual([]);

    managers.register('manager-1', 'agent', { managerRunId: 'manager-1' });

    expect(
      tool(managers, ops())
        .list(LISTING)
        .map((listed) => listed.name),
    ).toEqual([HOST_READ_COMMAND_CENTER_TOOL]);
  });

  it('lists read_command_center on a manager turn, and neither list_threads nor message_thread', () => {
    const managers = new CommandCenterBroker();
    managers.register('manager-1', 'agent', { managerRunId: 'manager-1' });

    const names = listedNamesFor(managers, ops());

    expect(names).toContain(HOST_READ_COMMAND_CENTER_TOOL);
    expect(names).not.toContain('list_threads');
    expect(names).not.toContain('message_thread');
  });

  it('lists list_threads and message_thread, and not read_command_center, on an ordinary chat turn', () => {
    const names = listedNamesFor(new CommandCenterBroker(), ops());

    expect(names).toContain('list_threads');
    expect(names).toContain('message_thread');
    expect(names).not.toContain(HOST_READ_COMMAND_CENTER_TOOL);
  });

  it('hands the manager run to the operations, and answers the graph it reads', async () => {
    const read = vi.fn(() => Promise.resolve(GRAPH));
    const managers = new CommandCenterBroker();
    managers.register('manager-1', 'agent', { managerRunId: 'manager-1' });

    const result = await tool(managers, ops({ read })).call(
      HOST_READ_COMMAND_CENTER_TOOL,
      {},
      CONTEXT,
    );

    expect(read).toHaveBeenCalledWith('manager-1');
    expect(result.isError).toBe(false);
    expect(textOf(result)).toBe(readCommandCenterResultText(GRAPH));
  });

  it('answers a refusal of the operations as an error, with the reason', async () => {
    const result = await tool(
      new CommandCenterBroker(),
      ops({
        read: () =>
          Promise.reject(
            new Error('only the command center manager may call this tool'),
          ),
      }),
    ).call(HOST_READ_COMMAND_CENTER_TOOL, {}, { ...CONTEXT, runId: 'run-2' });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      'The command center could not answer: only the command center manager may call this tool',
    );
  });

  it('answers in-protocol when no command center is installed to answer it', async () => {
    const result = await tool(
      new CommandCenterBroker(),
      new CommandCenterOpsBroker(),
    ).call(HOST_READ_COMMAND_CENTER_TOOL, {}, CONTEXT);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('The command center is not available.');
  });

  it('refuses malformed arguments in-protocol, without reaching the operations', async () => {
    const read = vi.fn(() => Promise.resolve(GRAPH));

    const result = await tool(new CommandCenterBroker(), ops({ read })).call(
      HOST_READ_COMMAND_CENTER_TOOL,
      { x: 1 },
      CONTEXT,
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/^INVALID_ARGS: /);
    expect(read).not.toHaveBeenCalled();
  });
});
