import { describe, expect, it } from 'vitest';

import { fakeSpawn } from '../__tests__/fake-child';
import type { SpawnFn } from '../utils/spawn-cli';
import type {
  AdapterConfig,
  AgentEvent,
  AgentModel,
  AgentTurnInput,
  TurnStdioSink,
} from './adapter.types';
import { AgentAdapter } from './agent-adapter';
import { CursorAcpAdapter } from './cursor-acp/cursor-acp.adapter';

/**
 * The bare minimum an adapter author supplies. Built on `AgentAdapter` itself
 * so the tee is pinned on the BASE's one spawn path — the property that makes
 * it adapter-agnostic — rather than on either shipped CLI's behaviour.
 */
class BareAdapter extends AgentAdapter {
  constructor(
    spawn: SpawnFn,
    private readonly argv: string[] = ['-p'],
    private readonly argvThrows = false,
  ) {
    super({ spawn });
  }

  protected get command(): string {
    return 'fake-cli';
  }

  getConfig(): AdapterConfig {
    return new CursorAcpAdapter().getConfig();
  }

  protected buildArgs(): string[] {
    if (this.argvThrows) {
      throw new Error('bad argv');
    }
    return this.argv;
  }

  protected mapMessage(): AgentEvent[] {
    return [];
  }

  override listModels(): Promise<AgentModel[]> {
    return Promise.resolve([]);
  }
}

/** Records everything the base tells the mirror, in order. */
function recordingSink(): { sink: TurnStdioSink; log: string[] } {
  const log: string[] = [];
  return {
    log,
    sink: {
      spawned: (command, args) =>
        log.push(`spawned:${command} ${args.join(' ')}`),
      data: (stream, chunk) => log.push(`${stream}:${chunk}`),
      settled: () => log.push('settled'),
    },
  };
}

const INPUT = (mirror: TurnStdioSink): AgentTurnInput => ({
  prompt: 'hi',
  cwd: '/proj',
  mirror,
});

describe('AgentAdapter.start — the mirror contract', () => {
  it('banners the argv, tees both streams, then reports the settle', async () => {
    const { spawn, child } = fakeSpawn();
    const { sink, log } = recordingSink();

    const handle = new BareAdapter(spawn, ['-p', '--model', 'x']).start(
      INPUT(sink),
      () => {},
    );
    child.stdout.emitData('out');
    child.stderr.emitData('err');
    child.emit('close', 0, null);
    await handle.done;

    expect(log).toEqual([
      // Banner first, before any output — the command line is the one thing
      // that makes the rest of the stream readable.
      'spawned:fake-cli -p --model x',
      'stdout:out',
      'stderr:err',
      'settled',
    ]);
  });

  it('tells the mirror the turn ended even when the spawn throws', async () => {
    // Otherwise the panel sits on a banner it was told about and a turn it was
    // never told ended — indistinguishable from a hung turn.
    const spawn: SpawnFn = () => {
      throw new Error('ENOENT');
    };
    const { sink, log } = recordingSink();

    // `runHeadlessCli` converts a spawn failure into an error event and a
    // settled handle rather than throwing, so `start` returns normally.
    const handle = new BareAdapter(spawn).start(INPUT(sink), () => {});
    await handle.done;

    expect(log).toEqual(['spawned:fake-cli -p', 'settled']);
  });

  it('says NOTHING to the mirror when building the argv throws', async () => {
    // The synchronous-throw path out of `start`. It never reaches
    // `runHeadlessCli`, which owns the whole sink lifecycle — so the mirror is
    // told neither that a turn started nor that one ended, rather than being
    // handed a settle for a turn it was never told about.
    const { spawn } = fakeSpawn();
    const { sink, log } = recordingSink();
    const adapter = new BareAdapter(spawn, [], true);

    expect(() => adapter.start(INPUT(sink), () => {})).toThrow('bad argv');

    expect(log).toEqual([]);
  });

  it('runs a turn with no mirror exactly as before', async () => {
    const { spawn, child } = fakeSpawn();
    const events: AgentEvent[] = [];

    const handle = new BareAdapter(spawn).start(
      { prompt: 'hi', cwd: '/proj' },
      (e) => events.push(e),
    );
    child.stdout.emitData('{"noise":1}\n');
    child.emit('close', 1, null);
    await handle.done;

    expect(events.some((e) => e.type === 'error')).toBe(true);
  });
});
