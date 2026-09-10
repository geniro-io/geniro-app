import type { EntityManager } from '@mikro-orm/sqlite';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ItemDao } from '../dao/item.dao';
import type { AgentEventBus } from './agent-events.bus';
import type { ChatService } from './chat.service';
import { ChatShellsService } from './chat-shells.service';
import type { ItemSeqAllocator } from './item-seq.allocator';

/**
 * The machine, faked at the two module seams `kill` reads it through — the
 * process table and the signals. Nothing here may signal a real process: this
 * suite runs beside whatever else the developer has open, and
 * `pidsRunningCommand` deliberately matches a PREFIX, so a needle that escaped
 * would not stop at the fixtures.
 *
 * `pidsRunningCommand` itself is the REAL one, because it is the whole of what
 * decides which pids a press reaches — faking it would leave every assertion
 * below describing the fake.
 */
const machine = vi.hoisted(() => ({
  processes: [] as { pid: number; ppid: number; args: string }[],
  signals: [] as { pid: number | undefined; signal: string }[],
}));

vi.mock('../utils/process-descendants', async (importActual) => ({
  ...(await importActual<object>()),
  listProcesses: async () => machine.processes,
}));

vi.mock('../utils/kill-tree', async (importActual) => ({
  ...(await importActual<object>()),
  killProcessGroup: (pid: number | undefined, signal: string) => {
    machine.signals.push({ pid, signal });
  },
}));

interface Row {
  seq: number;
  kind: string;
  payload: string;
  nodeId: string | null;
  createdAt: Date;
}

function lifecycle(
  seq: number,
  kind: 'shell_open' | 'shell_info',
  id: string,
  nodeId: string | null = null,
): Row {
  return {
    seq,
    kind,
    payload: JSON.stringify({ id, workId: `w-${id}` }),
    nodeId,
    createdAt: new Date(seq * 1000),
  };
}

/** Every row `close` wrote — the `shell_info` a killed command owes. */
interface WrittenRow {
  runId: string;
  nodeId: string | null;
  seq: number;
  kind: string;
  payload: unknown;
}

function service(
  rows: Row[],
  calls: { id: string; command?: string; name?: string }[],
): {
  service: ChatShellsService;
  asked: string[][];
  written: WrittenRow[];
  published: WrittenRow[];
  uncounted: { runId: string; workId: string | null }[];
} {
  const asked: string[][] = [];
  const written: WrittenRow[] = [];
  const published: WrittenRow[] = [];
  const itemDao = {
    shellLifecycleRows: async () => rows,
    toolCallsByIds: async (_runId: string, ids: readonly string[]) => {
      asked.push([...ids]);
      return calls
        .filter((call) => ids.includes(call.id))
        .map((call) => ({
          payload: JSON.stringify({
            id: call.id,
            name: call.name ?? 'Bash',
            ...(call.command === undefined
              ? {}
              : { input: { command: call.command } }),
          }),
          nodeId: null,
          createdAt: new Date(0),
        }));
    },
    // What `persistItemAndEmit` writes through — the real helper runs, so the
    // close is pinned as the row it actually stores rather than as a call to a
    // doubled `close`.
    create: async (row: WrittenRow & { payload: string }) => {
      written.push({ ...row, payload: JSON.parse(row.payload) });
      return { id: `item-${written.length}`, createdAt: new Date(0) };
    },
  } as unknown as ItemDao;
  const bus = {
    publish: ({ item }: { item: WrittenRow }) => {
      published.push(item);
    },
  } as unknown as AgentEventBus;
  const seqs = { reserve: async () => 99 } as unknown as ItemSeqAllocator;
  const uncounted: { runId: string; workId: string | null }[] = [];
  const chats = {
    noteShellClosed: (runId: string, workId: string | null) => {
      uncounted.push({ runId, workId });
    },
  } as unknown as ChatService;
  return {
    service: new ChatShellsService(
      { fork: () => ({ clear: () => undefined }) } as unknown as EntityManager,
      itemDao,
      bus,
      seqs,
      chats,
    ),
    asked,
    written,
    published,
    uncounted,
  };
}

beforeEach(() => {
  machine.processes = [];
  machine.signals = [];
  vi.useRealTimers();
});

describe('ChatShellsService', () => {
  it('answers the commands still running over the WHOLE conversation', async () => {
    // The point of the route. The renderer folds the same list from the loaded
    // transcript window, so a command detached before it drops off the list
    // while the run keeps counting it — the reported `working` badge over an
    // empty shelf. Here the open row sits at seq 1 of a conversation whose
    // newest rows are thousands later, which is exactly the case a client fold
    // cannot reach.
    const { service: svc } = service(
      [
        lifecycle(1, 'shell_open', 'call-old'),
        lifecycle(2, 'shell_open', 'call-closed'),
        lifecycle(3, 'shell_info', 'call-closed'),
      ],
      [
        { id: 'call-old', command: 'pnpm dev' },
        { id: 'call-closed', command: 'pnpm build' },
      ],
    );

    const answer = await svc.read('run-1');

    expect(answer.shells).toEqual([
      {
        id: 'call-old',
        command: 'pnpm dev',
        nodeId: null,
        startedAt: 1000,
      },
    ]);
  });

  it('asks for the words of the OPEN commands alone', async () => {
    // The join is addressed, never scanned: the thread this was measured on
    // holds thousands of tool calls and, at the moment of the report, one open
    // command. A scan would read the whole run to answer about one row.
    const { service: svc, asked } = service(
      [
        lifecycle(1, 'shell_open', 'a'),
        lifecycle(2, 'shell_open', 'b'),
        lifecycle(3, 'shell_info', 'b'),
      ],
      [{ id: 'a', command: 'sleep 300' }],
    );

    await svc.read('run-1');

    expect(asked).toEqual([['a']]);
  });

  it('keeps a command whose call it could not read, named by its id', async () => {
    // It is still RUNNING. Dropping it would put the badge's count back over
    // the list, which is the whole defect this answers — so an unreadable call
    // costs the words and never the row.
    const { service: svc } = service([lifecycle(1, 'shell_open', 'ghost')], []);

    const answer = await svc.read('run-1');

    expect(answer.shells).toEqual([
      { id: 'ghost', command: 'ghost', nodeId: null, startedAt: 1000 },
    ]);
  });

  it('carries the workflow NODE that started it', async () => {
    // The shelf labels a workflow's rows by agent, and that is the only place
    // the question arises — a 1:1 chat writes null here.
    const { service: svc } = service(
      [lifecycle(1, 'shell_open', 'c', 'qa')],
      [{ id: 'c', command: 'pnpm test' }],
    );

    const answer = await svc.read('run-1');

    expect(answer.shells[0]?.nodeId).toBe('qa');
  });

  it('answers nothing for a run whose commands have all finished', async () => {
    const { service: svc, asked } = service(
      [lifecycle(1, 'shell_open', 'a'), lifecycle(2, 'shell_info', 'a')],
      [{ id: 'a', command: 'ls' }],
    );

    const answer = await svc.read('run-1');

    expect(answer.shells).toEqual([]);
    // …and it does not go looking for words it has no rows to attach them to.
    expect(asked).toEqual([]);
  });
});

describe('ChatShellsService.kill', () => {
  it('SIGTERMs every process running that command, then SIGKILLs', async () => {
    // The GROUP and not the pid, and every match rather than the first: a CLI
    // wraps what it runs, so one command is routinely two rows — here the zsh
    // preamble cursor puts in front of it and the command itself. Killing the
    // leaf alone would leave the wrapper holding the terminal.
    vi.useFakeTimers();
    machine.processes = [
      { pid: 41, ppid: 1, args: '/bin/zsh -lc -- pnpm dev' },
      { pid: 42, ppid: 41, args: 'pnpm dev' },
      { pid: 43, ppid: 1, args: 'pnpm build' },
    ];
    const { service: svc } = service(
      [lifecycle(1, 'shell_open', 'call-1')],
      [{ id: 'call-1', command: 'pnpm dev' }],
    );

    const answer = await svc.kill('run-1', 'call-1');

    expect(answer).toEqual({ killed: true, reason: null });
    expect(machine.signals).toEqual([
      { pid: 41, signal: 'SIGTERM' },
      { pid: 42, signal: 'SIGTERM' },
    ]);
    // Asked to stop before being made to — the courtesy every other kill path
    // here extends, since a `pnpm dev` holds children and writes files.
    await vi.advanceTimersByTimeAsync(2000);
    expect(machine.signals.slice(2)).toEqual([
      { pid: 41, signal: 'SIGKILL' },
      { pid: 42, signal: 'SIGKILL' },
    ]);
  });

  it('writes the close itself, since nothing else will', async () => {
    // The row that would have announced the ending is the CLI's own bracket,
    // and the CLI is gone. Without this the command would go on being listed
    // as running by the very fold that just killed it.
    machine.processes = [{ pid: 42, ppid: 1, args: 'pnpm dev' }];
    const {
      service: svc,
      written,
      published,
      uncounted,
    } = service(
      [lifecycle(1, 'shell_open', 'call-1', 'qa')],
      [{ id: 'call-1', command: 'pnpm dev' }],
    );

    await svc.kill('run-1', 'call-1');

    expect(written).toEqual([
      {
        runId: 'run-1',
        // The node that STARTED it, carried over from the open — a close filed
        // at the wrong node is the defect item 5 fixed one level up.
        nodeId: 'qa',
        seq: 99,
        kind: 'shell_info',
        role: null,
        payload: {
          id: 'call-1',
          // The CLI's own handle, carried from the open so this close is the
          // same shape every other one has — `shell-activity.ts` matches by
          // call, ELSE by this.
          workId: 'w-call-1',
          killedByUser: true,
        },
        searchText: expect.anything(),
      },
    ]);
    // Persist THEN emit, so a reconnecting client replays a durable row.
    expect(published).toHaveLength(1);
    // And the run's LIVE count comes down with it. Nothing else will bring it
    // down: the count is kept off the CLI's own brackets and the CLI already
    // answered this command's launch, so without this the badge reads
    // `working · waiting on background work` for the rest of the session.
    expect(uncounted).toEqual([{ runId: 'run-1', workId: 'w-call-1' }]);
  });

  it('takes a row off the list when the machine says it already stopped', async () => {
    // The transcript says open and `ps` says otherwise — a command that died
    // with no one to write its close. Recording it is the useful answer, and it
    // is what takes the row off the list.
    const { service: svc, written } = service(
      [lifecycle(1, 'shell_open', 'call-1')],
      [{ id: 'call-1', command: 'pnpm dev' }],
    );

    const answer = await svc.kill('run-1', 'call-1');

    expect(answer.killed).toBe(false);
    expect(answer.reason).toContain('already stopped');
    expect(machine.signals).toEqual([]);
    expect(written).toHaveLength(1);
  });

  it('signals NOTHING for a command this run never had open', async () => {
    // The list a user pressed from is a snapshot, so a command that finished on
    // its own between the render and the press is the ordinary race — and a
    // command from ANOTHER conversation must never be reachable by id alone,
    // which is what makes this the load-bearing half.
    machine.processes = [{ pid: 42, ppid: 1, args: 'pnpm dev' }];
    const { service: svc, written } = service(
      [lifecycle(1, 'shell_open', 'call-1')],
      [{ id: 'call-1', command: 'pnpm dev' }],
    );

    const answer = await svc.kill('run-1', 'someone-elses-call');

    expect(answer).toEqual({
      killed: false,
      reason: 'that command is no longer running',
    });
    expect(machine.signals).toEqual([]);
    expect(written).toEqual([]);
  });

  it('REFUSES a command whose call could not be read, rather than guessing', async () => {
    // Such a row is DRAWN under its id, because it is still running and the
    // count would otherwise outrun the list. An id is not a command, and the
    // match is a PREFIX — so signalling on one can only hit by accident, and
    // what it hits is somebody else's process. Here `ghost --serve` is exactly
    // that accident: a process the row has nothing to do with, which a fold
    // that let the display fallback through to the kill would have killed.
    machine.processes = [{ pid: 42, ppid: 1, args: 'ghost --serve' }];
    const { service: svc, written } = service(
      [lifecycle(1, 'shell_open', 'ghost')],
      [],
    );

    const answer = await svc.kill('run-1', 'ghost');

    expect(machine.signals).toEqual([]);
    expect(answer.killed).toBe(false);
    expect(answer.reason).toContain('cannot tell which process');
    // And the row STAYS: it is still running, so writing its close would take
    // it off a list it belongs on.
    expect(written).toEqual([]);
  });
});
