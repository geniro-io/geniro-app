import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { HostWake } from '../chat.types';
import {
  chatWakeOwner,
  COMMAND_END_WAKE_BATCH_MS,
  CommandEndWakeService,
  MAX_COMMAND_END_WAKES,
  memberWakeOwner,
} from './command-end-wake.service';
import { HostWakeBus } from './host-wake.bus';

const RUN = 'run-1';

function ending(command: string, exitCode: number | null = 0) {
  return { command, exitCode, outputPath: `/tmp/terminals/${command}.txt` };
}

describe('CommandEndWakeService', () => {
  let bus: HostWakeBus;
  let wakes: HostWake[];
  let service: CommandEndWakeService;
  let turnRunning: boolean;
  const running = (): boolean => turnRunning;

  beforeEach(() => {
    vi.useFakeTimers();
    bus = new HostWakeBus();
    wakes = [];
    bus.subscribe((wake) => wakes.push(wake));
    service = new CommandEndWakeService(bus);
    turnRunning = false;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function settle(): void {
    vi.advanceTimersByTime(COMMAND_END_WAKE_BATCH_MS);
  }

  it('wakes the conversation once with every command that ended within the window', () => {
    service.ended(chatWakeOwner(RUN), 'w1', ending('make build', 2), running);
    vi.advanceTimersByTime(COMMAND_END_WAKE_BATCH_MS - 1);
    service.ended(chatWakeOwner(RUN), 'w2', ending('make test'), running);
    expect(wakes).toHaveLength(0);
    settle();

    expect(wakes).toHaveLength(1);
    const [wake] = wakes;
    expect(wake!.owner).toEqual(chatWakeOwner(RUN));
    expect(wake!.note).toBeNull();
    expect(wake!.prompt).toContain('2 background commands');
    expect(wake!.prompt).toContain('`make build` — exit code 2');
    expect(wake!.prompt).toContain('/tmp/terminals/make test.txt');
    expect(wake!.prompt).toContain('do not report it a second time');
    expect(wake!.row).toMatchObject({ severity: 'info', woke: true });
  });

  it('says the exit code is unknown when the CLI recorded none', () => {
    service.ended(chatWakeOwner(RUN), 'w1', ending('sleep 40', null), running);
    settle();
    expect(wakes[0]!.prompt).toContain('`sleep 40` — exit code unknown');
  });

  it('wakes nobody for a command that ended while a turn runs', () => {
    turnRunning = true;
    service.ended(chatWakeOwner(RUN), 'w1', ending('make build'), running);
    settle();
    expect(wakes).toHaveLength(0);
  });

  it('drops a pending wake when a turn starts before it is sent', () => {
    service.ended(chatWakeOwner(RUN), 'w1', ending('make build'), running);
    service.turnStarted(chatWakeOwner(RUN));
    settle();
    expect(wakes).toHaveLength(0);
  });

  it('withdraws a published wake once a turn has started', () => {
    service.ended(chatWakeOwner(RUN), 'w1', ending('make build'), running);
    settle();
    expect(wakes[0]!.withdrawn?.()).toBe(false);
    service.turnStarted(chatWakeOwner(RUN));
    expect(wakes[0]!.withdrawn?.()).toBe(true);
  });

  it('drops the wake when a turn is running by the time the window closes', () => {
    service.ended(chatWakeOwner(RUN), 'w1', ending('make build'), running);
    turnRunning = true;
    settle();
    expect(wakes).toHaveLength(0);
  });

  it('stops waking after the cap until the user writes again', () => {
    for (let i = 0; i < MAX_COMMAND_END_WAKES; i += 1) {
      service.ended(chatWakeOwner(RUN), `w${i}`, ending(`step ${i}`), running);
      settle();
      wakes.at(-1)!.onDelivered();
    }
    expect(wakes).toHaveLength(MAX_COMMAND_END_WAKES);

    service.ended(chatWakeOwner(RUN), 'over', ending('one more'), running);
    settle();
    expect(wakes).toHaveLength(MAX_COMMAND_END_WAKES);

    service.userSpoke(RUN);
    service.ended(chatWakeOwner(RUN), 'after', ending('after reply'), running);
    settle();
    expect(wakes).toHaveLength(MAX_COMMAND_END_WAKES + 1);
  });

  it('wakes nobody for a command the user stopped', () => {
    service.stoppedByUser(chatWakeOwner(RUN), 'w1');
    service.ended(chatWakeOwner(RUN), 'w1', ending('npm run dev'), running);
    settle();
    expect(wakes).toHaveLength(0);
  });

  it('forgets a stopped or archived run, withdrawing what it published', () => {
    service.ended(chatWakeOwner(RUN), 'w1', ending('make build'), running);
    settle();
    service.ended(chatWakeOwner(RUN), 'w2', ending('make test'), running);
    service.forgetRun(RUN);
    settle();

    expect(wakes).toHaveLength(1);
    expect(wakes[0]!.withdrawn?.()).toBe(true);
  });

  it('keeps each team member’s own conversation apart', () => {
    service.ended(memberWakeOwner(RUN, 'qa'), 'w1', ending('a'), running);
    service.ended(memberWakeOwner(RUN, 'dev'), 'w2', ending('b'), running);
    service.turnStarted(memberWakeOwner(RUN, 'dev'));
    settle();

    expect(wakes).toHaveLength(1);
    expect(wakes[0]!.owner).toEqual(memberWakeOwner(RUN, 'qa'));
  });
});
