// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  type QueuedMessage,
  readStoredQueueState,
  writeStoredQueueState,
} from './queued-message-store';

const message = (over: Partial<QueuedMessage> = {}): QueuedMessage => ({
  id: 'q1',
  text: 'follow up',
  images: [],
  ...over,
});

const NONE = new Set<string>();

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('queued-message-store', () => {
  it('survives a reload, which a phone discarding its tab amounts to', () => {
    // The composer is cleared the moment a message is queued, so a queue held
    // in memory alone would lose it outright on any reload before the drain.
    writeStoredQueueState({
      queues: { 'run-1': [message()] },
      paused: NONE,
      sending: {},
    });

    const restored = readStoredQueueState();
    expect(restored.queues).toEqual({ 'run-1': [message()] });
    expect([...restored.paused]).toEqual([]);
  });

  it('forgets a run whose queue has emptied', () => {
    writeStoredQueueState({
      queues: { 'run-1': [message()] },
      paused: NONE,
      sending: {},
    });
    writeStoredQueueState({
      queues: { 'run-1': [] },
      paused: NONE,
      sending: {},
    });

    expect(readStoredQueueState().queues).toEqual({});
  });

  it('keeps a PAUSED queue paused across the reload', () => {
    // Restored without its pause, a held queue drained by itself.
    writeStoredQueueState({
      queues: { 'run-1': [message()] },
      paused: new Set(['run-1']),
      sending: {},
    });

    expect([...readStoredQueueState().paused]).toEqual(['run-1']);
  });

  it('holds a run whose head was MID-SEND, rather than sending it twice', () => {
    // The reply was what the reload lost, so the message may already have
    // reached the agent; the user decides.
    writeStoredQueueState({
      queues: { 'run-1': [message()], 'run-2': [message({ id: 'q2' })] },
      paused: NONE,
      sending: { 'run-1': 'q1' },
    });

    expect([...readStoredQueueState().paused]).toEqual(['run-1']);
  });

  it('keeps the WORDS when the images overrun the quota', () => {
    const real = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
      this: Storage,
      key: string,
      value: string,
    ) {
      if (value.includes('BASE64')) {
        throw new DOMException('quota', 'QuotaExceededError');
      }
      real.call(this, key, value);
    });

    writeStoredQueueState({
      queues: {
        'run-1': [
          message({
            images: [
              { mediaType: 'image/png', data: 'BASE64' },
            ] as QueuedMessage['images'],
          }),
        ],
      },
      paused: NONE,
      sending: {},
    });

    expect(readStoredQueueState().queues).toEqual({ 'run-1': [message()] });
  });

  it('reads nothing rather than throwing on a corrupted entry', () => {
    localStorage.setItem('geniro.queuedMessages', '{not json');

    expect(readStoredQueueState().queues).toEqual({});
  });
});
