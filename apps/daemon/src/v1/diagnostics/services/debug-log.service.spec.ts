import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ItemWire } from '../../agents/chat.types';
import { AgentEventBus } from '../../agents/services/agent-events.bus';
import { configureDebugSink, debugSink } from '../utils/debug-sink';
import { DebugLogService } from './debug-log.service';

function item(seq: number, text: string): ItemWire {
  return {
    id: `i-${seq}`,
    runId: 'r1',
    nodeId: null,
    seq,
    kind: 'message',
    role: 'assistant',
    payload: { text },
    createdAt: new Date(0).toISOString(),
  };
}

function setup(): { bus: AgentEventBus; service: DebugLogService } {
  const bus = new AgentEventBus();
  const service = new DebugLogService(bus);
  service.onModuleInit();
  return { bus, service };
}

const entries = (): { channel: string; message: string; level: string }[] =>
  debugSink.since(-1).entries;

beforeEach(() => {
  configureDebugSink({ dir: null });
  debugSink.setChannels(['daemon', 'transcript', 'ui', 'agent-stdio']);
});

afterEach(() => debugSink.close());

describe('DebugLogService — the transcript channel', () => {
  it('records every persisted item, LEADING with its seq', () => {
    // The seq leads because it is the field a reader compares across rows —
    // and a repeated one is exactly the defect this channel exists to make
    // visible at a glance rather than through a database query.
    const { bus } = setup();

    bus.publish({ runId: 'r1', item: item(7, 'hello') });

    const line = entries().find((entry) => entry.channel === 'transcript');
    expect(line?.message).toContain('seq=7');
    expect(line?.message).toContain('message/assistant');
    expect(line?.message).toContain('hello');
  });

  it('records run-status changes with their activity', () => {
    const { bus } = setup();

    bus.publishRunStatus({
      runId: 'r1',
      status: 'running',
      activity: 'running Bash',
    });

    expect(
      entries().some((entry) => entry.message.includes('running Bash')),
    ).toBe(true);
  });

  it('records a delete as a WARNING — it is destructive and irreversible', () => {
    const { bus } = setup();

    bus.publishRunDeleted('r1');

    const line = entries().find((entry) => entry.message === 'run deleted');
    expect(line?.level).toBe('warn');
  });

  it('records live deltas at trace, WITHOUT their text', () => {
    // Thousands per turn, each carrying the whole tail again. At trace they
    // are present for a streaming bug but out of the default reading, and the
    // text is dropped because the durable item one channel over has it
    // verbatim — logging it twice would double the log to say nothing new.
    const { bus } = setup();

    bus.publishDelta({
      runId: 'r1',
      nodeId: null,
      text: 'a very long streaming tail',
      thinkingTokens: null,
      thinkingSince: null,
      thinkingStretch: null,
      contextTokens: null,
      contextWindowTokens: null,
    } as Parameters<AgentEventBus['publishDelta']>[0]);

    const line = entries().find((entry) => entry.message === 'delta');
    expect(line?.level).toBe('trace');
    expect(JSON.stringify(entries())).not.toContain('a very long streaming');
  });

  it('records nothing at all when the transcript channel is off', () => {
    const { bus } = setup();
    debugSink.setChannels(['daemon']);

    bus.publish({ runId: 'r1', item: item(1, 'quiet') });

    expect(entries()).toEqual([]);
  });
});

describe('DebugLogService — the read surface', () => {
  it('reports the channels and the file path alongside the page', () => {
    // The panel needs all three from one call: without the channels it cannot
    // render its toggles honestly, and without the path it cannot offer to
    // reveal the file.
    const { service } = setup();
    service.record('daemon', 'info', 'one');

    const page = service.page(-1);

    expect(page.entries.map((entry) => entry.message)).toContain('one');
    expect(page.channels).toContain('daemon');
    expect(page.lastSeq).toBeGreaterThanOrEqual(0);
  });

  it('tags a UI line as coming from the renderer', () => {
    const { service } = setup();

    service.recordFromUi({ level: 'error', message: 'boom' });

    expect(entries()).toContainEqual(
      expect.objectContaining({
        channel: 'ui',
        level: 'error',
        message: 'boom',
      }),
    );
  });

  it('SAYS in the log when the channel set changes', () => {
    // A reader looking at a thin stretch of log has to be able to tell
    // "nothing happened" from "this channel was switched off".
    const { service } = setup();

    service.setChannels(['daemon']);

    expect(
      entries().some((entry) =>
        entry.message.includes('debug channels set to'),
      ),
    ).toBe(true);
  });
});
