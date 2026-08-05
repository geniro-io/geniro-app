import { describe, expect, it } from 'vitest';

import { fakeSpawn } from '../__tests__/fake-child';
import type { AgentEvent } from '../adapters/adapter.types';
import { runHeadlessCli } from './spawn-cli';

describe('runHeadlessCli — the raw stdio tee', () => {
  it('tees both streams verbatim, and still parses stdout as before', async () => {
    const { spawn, child } = fakeSpawn();
    const tee: [string, string][] = [];
    const events: AgentEvent[] = [];

    const handle = runHeadlessCli({
      command: 'claude',
      args: [],
      cwd: '/proj',
      mapper: () => [{ type: 'text', text: 'hi' }],
      onEvent: (e) => events.push(e),
      mirror: {
        spawned: () => {},
        data: (s2, c) => tee.push([s2, c]),
        settled: () => {},
      },
      spawn,
    });

    child.stdout.emitData('{"type":"assistant"}\n');
    // stderr reaches NO other surface: `runHeadlessCli` keeps only a tail, and
    // only to decorate a non-zero exit.
    child.stderr.emitData('a deprecation warning\n');
    child.emit('close', 0, null);
    await handle.done;

    expect(tee).toEqual([
      ['stdout', '{"type":"assistant"}\n'],
      ['stderr', 'a deprecation warning\n'],
    ]);
    // The tee is a bystander: the NDJSON parse still happened.
    expect(events).toContainEqual({ type: 'text', text: 'hi' });
  });

  it('survives a sink that throws, and keeps parsing the same chunk', async () => {
    // The defensive branch. The tee runs INSIDE the stdout data handler, which
    // owns the turn's entire output — an escaping throw would strand the turn
    // with no events and no terminal item, over a mirror nobody is required to
    // be watching.
    const { spawn, child } = fakeSpawn();
    const events: AgentEvent[] = [];
    const warnings: string[] = [];

    const handle = runHeadlessCli({
      command: 'claude',
      args: [],
      cwd: '/proj',
      mapper: () => [{ type: 'text', text: 'parsed anyway' }],
      onEvent: (e) => events.push(e),
      mirror: {
        spawned: () => {},
        data: () => {
          throw new Error('mirror exploded');
        },
        settled: () => {},
      },
      logger: { warn: (m) => warnings.push(m) },
      spawn,
    });

    child.stdout.emitData('{"type":"assistant"}\n');
    child.emit('close', 0, null);
    await handle.done;

    expect(events).toContainEqual({ type: 'text', text: 'parsed anyway' });
    expect(warnings.some((w) => w.includes('mirror exploded'))).toBe(true);
  });

  it('runs unmirrored when no sink is given — silently', async () => {
    // Every turn passes through here, and most graph/probe turns are not
    // mirrored, so the absent-sink path must cost nothing. The logger assertion
    // is what makes this a real pin: without the `if (!opts.mirror) return`
    // guard, calling into an absent sink throws into the wrapper's own catch
    // and the turn still succeeds — only the warning betrays it.
    const { spawn, child } = fakeSpawn();
    const events: AgentEvent[] = [];
    const warnings: string[] = [];

    const handle = runHeadlessCli({
      command: 'claude',
      args: [],
      cwd: '/proj',
      mapper: () => [{ type: 'text', text: 'fine' }],
      onEvent: (e) => events.push(e),
      logger: { warn: (m) => warnings.push(m) },
      spawn,
    });

    child.stdout.emitData('{"type":"assistant"}\n');
    child.stderr.emitData('some noise');
    child.emit('close', 0, null);
    await handle.done;

    expect(events).toContainEqual({ type: 'text', text: 'fine' });
    expect(warnings).toEqual([]);
  });
});
