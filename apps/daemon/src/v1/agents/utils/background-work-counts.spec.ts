import { describe, expect, it } from 'vitest';

import type { AgentEvent } from '../adapters/adapter.types';
import {
  type BackgroundCountsPatch,
  BackgroundWorkCounts,
} from './background-work-counts';

function counts(): {
  subject: BackgroundWorkCounts;
  announced: [string, BackgroundCountsPatch][];
} {
  const announced: [string, BackgroundCountsPatch][] = [];
  return {
    subject: new BackgroundWorkCounts((runId, patch) =>
      announced.push([runId, patch]),
    ),
    announced,
  };
}

const shellOpen = (workId: string): AgentEvent => ({
  type: 'shell_open',
  toolCallId: null,
  workId,
});
const shellClose = (workId: string): AgentEvent => ({
  type: 'shell_info',
  toolCallId: null,
  workId,
});
const delegate = (id: string, backgroundOpen: boolean | null): AgentEvent =>
  ({ type: 'subagent_info', id, backgroundOpen }) as AgentEvent;

describe('BackgroundWorkCounts', () => {
  it('counts shells per run and announces each change', () => {
    const { subject, announced } = counts();
    subject.record('r1', shellOpen('b1'));
    subject.record('r1', shellOpen('b2'));
    subject.record('r2', shellOpen('b3'));
    subject.record('r1', shellClose('b1'));

    expect(subject.shellsOpen('r1')).toBe(1);
    expect(subject.shellsOpen('r2')).toBe(1);
    expect(announced).toEqual([
      ['r1', { shellsOpen: 1 }],
      ['r1', { shellsOpen: 2 }],
      ['r2', { shellsOpen: 1 }],
      ['r1', { shellsOpen: 1 }],
    ]);
  });

  it('announces a duplicate close only once — claude reports an ending twice', () => {
    const { subject, announced } = counts();
    subject.record('r1', shellOpen('b1'));
    subject.record('r1', shellClose('b1'));
    subject.record('r1', shellClose('b1'));

    expect(subject.shellsOpen('r1')).toBe(0);
    expect(announced).toEqual([
      ['r1', { shellsOpen: 1 }],
      ['r1', { shellsOpen: 0 }],
    ]);
  });

  it('counts background delegates and ignores a declaration that says nothing', () => {
    const { subject, announced } = counts();
    subject.record('r1', delegate('t1', true));
    subject.record('r1', delegate('t2', null));
    subject.record('r1', delegate('t1', false));

    expect(subject.subagentsOut('r1')).toBe(0);
    expect(announced).toEqual([
      ['r1', { subagentsOut: 1 }],
      ['r1', { subagentsOut: 0 }],
    ]);
  });

  it('retires every delegate at once, announcing only when one was out', () => {
    const { subject, announced } = counts();
    subject.retireDelegates('r1');
    subject.record('r1', delegate('t1', true));
    subject.record('r1', delegate('t2', true));
    subject.retireDelegates('r1');

    expect(subject.subagentsOut('r1')).toBe(0);
    expect(announced.at(-1)).toEqual(['r1', { subagentsOut: 0 }]);
    expect(announced).toHaveLength(3);
  });

  it('closes a killed shell by its work id and ignores one that has none', () => {
    const { subject } = counts();
    subject.record('r1', shellOpen('b1'));
    subject.noteShellClosed('r1', null);
    expect(subject.shellsOpen('r1')).toBe(1);
    subject.noteShellClosed('r1', 'b1');
    expect(subject.shellsOpen('r1')).toBe(0);
  });

  it('forgets a deleted run without announcing', () => {
    const { subject, announced } = counts();
    subject.record('r1', shellOpen('b1'));
    subject.record('r1', delegate('t1', true));
    const before = announced.length;
    subject.forget('r1');

    expect(subject.shellsOpen('r1')).toBe(0);
    expect(subject.subagentsOut('r1')).toBe(0);
    expect(announced).toHaveLength(before);
  });
});
