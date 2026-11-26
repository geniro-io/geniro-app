import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as environments from '../../../environments';
import {
  DAEMON_HEARTBEAT_NAME,
  type DaemonHeartbeat,
  HEARTBEAT_EVERY_MS,
} from '../../../utils/previous-stop';
import { DaemonHeartbeatService } from './daemon-heartbeat.service';

const userData = vi.hoisted(() => ({ dir: '' }));

vi.mock('../../../environments', async (importOriginal) => {
  const actual = await importOriginal<typeof environments>();
  return {
    ...actual,
    environment: {
      ...actual.environment,
      get userDataDir() {
        return userData.dir;
      },
    },
  };
});

const START = Date.UTC(2026, 10, 24, 10, 0, 0);

function readBeat(): DaemonHeartbeat {
  return JSON.parse(
    readFileSync(join(userData.dir, DAEMON_HEARTBEAT_NAME), 'utf8'),
  ) as DaemonHeartbeat;
}

describe('DaemonHeartbeatService', () => {
  let dir: string;
  let service: DaemonHeartbeatService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'geniro-heartbeat-'));
    userData.dir = dir;
    vi.useFakeTimers();
    vi.setSystemTime(START);
    service = new DaemonHeartbeatService();
  });

  afterEach(() => {
    service.onModuleDestroy();
    vi.useRealTimers();
    vi.restoreAllMocks();
    userData.dir = '';
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes a beat at once, naming this process and its resident memory', () => {
    service.onApplicationBootstrap();

    const beat = readBeat();
    expect(beat.pid).toBe(process.pid);
    expect(beat.at).toBe(START);
    expect(beat.rssBytes).toBeGreaterThan(0);
  });

  it('beats again every HEARTBEAT_EVERY_MS, and not sooner', () => {
    service.onApplicationBootstrap();

    vi.advanceTimersByTime(HEARTBEAT_EVERY_MS - 1);
    expect(readBeat().at).toBe(START);
    vi.advanceTimersByTime(1);
    expect(readBeat().at).toBe(START + HEARTBEAT_EVERY_MS);
    vi.advanceTimersByTime(HEARTBEAT_EVERY_MS);
    expect(readBeat().at).toBe(START + 2 * HEARTBEAT_EVERY_MS);
  });

  it('stops beating when the module is destroyed', () => {
    service.onApplicationBootstrap();
    service.onModuleDestroy();
    rmSync(join(dir, DAEMON_HEARTBEAT_NAME));

    vi.advanceTimersByTime(HEARTBEAT_EVERY_MS * 3);

    expect(existsSync(join(dir, DAEMON_HEARTBEAT_NAME))).toBe(false);
  });

  it('logs a failed write once, not on every beat, and again after a recovery', () => {
    const warn = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const missing = join(dir, 'missing');
    userData.dir = missing;

    service.onApplicationBootstrap();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('could not write the heartbeat'),
    );
    vi.advanceTimersByTime(HEARTBEAT_EVERY_MS * 3);
    expect(warn).toHaveBeenCalledTimes(1);

    mkdirSync(missing);
    vi.advanceTimersByTime(HEARTBEAT_EVERY_MS);
    expect(readBeat().at).toBe(START + HEARTBEAT_EVERY_MS * 4);

    rmSync(missing, { recursive: true, force: true });
    vi.advanceTimersByTime(HEARTBEAT_EVERY_MS);
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
