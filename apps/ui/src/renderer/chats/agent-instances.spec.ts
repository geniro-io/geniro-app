import { describe, expect, it } from 'vitest';

import type { AgentDisplay, AgentThread } from './agent-activity';
import {
  agentInstances,
  conversationTaskLists,
  hasInstanceContent,
  instanceIdentity,
  isInstanceLive,
} from './agent-instances';
import type { ShellRun } from './shell-activity';
import type { AgentTaskRow } from './task-payload';

const call = (
  id: string,
  status: AgentThread['status'] = 'running',
): Extract<AgentThread, { kind: 'call' }> => ({
  id,
  kind: 'call',
  callIds: [id],
  openCallIds: status === 'running' ? [id] : [],
  label: `${id} · brief`,
  status,
  sessionId: null,
});

const delegate = (
  id: string,
  callId: string | null,
  status: AgentThread['status'] = 'running',
): AgentThread => ({
  id,
  kind: 'subagent',
  label: id,
  status,
  sessionId: null,
  callId,
});

const shell = (id: string, callId: string | null): ShellRun => ({
  id,
  command: `run ${id}`,
  description: null,
  background: false,
  handle: null,
  status: 'running',
  exitCode: null,
  startedAt: new Date().toISOString(),
  agentId: 'engineer',
  callId,
});

const task = (id: string): AgentTaskRow => ({
  id,
  title: `task ${id}`,
  status: 'pending',
  activeForm: null,
});

const engineer = (threads: AgentThread[]): AgentDisplay => ({
  id: 'engineer',
  name: 'Engineer',
  agent: 'claude',
  model: null,
  configDir: null,
  status: 'running',
  activeTurns: 2,
  contextTokens: null,
  contextWindowTokens: null,
  spentUsd: null,
  inputTokens: null,
  outputTokens: null,
  cacheTokens: null,
  threads,
});

describe('agentInstances', () => {
  it('files every delegate, command and list under the conversation that started it', () => {
    // The reported panel, rebuilt: two Engineers at work, whose delegates,
    // commands and plans were all pooled under one card. Each must land in its
    // own instance and nowhere else.
    const instances = agentInstances(
      engineer([
        call('call-1'),
        call('call-2'),
        delegate('explore', 'call-1'),
        delegate('review', 'call-2'),
      ]),
      [shell('s1', 'call-2'), shell('s2', 'call-1')],
      [
        { threadId: 'call-2', tasks: [task('1'), task('2')] },
        { threadId: 'call-1', tasks: [task('1')] },
      ],
    );

    expect(instances.map((i) => i.thread.id)).toEqual(['call-1', 'call-2']);
    const [first, second] = instances;
    expect(first!.subagents.map((t) => t.id)).toEqual(['explore']);
    expect(first!.shells.map((s) => s.id)).toEqual(['s2']);
    expect(first!.tasks).toHaveLength(1);
    expect(second!.subagents.map((t) => t.id)).toEqual(['review']);
    expect(second!.shells.map((s) => s.id)).toEqual(['s1']);
    expect(second!.tasks).toHaveLength(2);
  });

  it('keeps the node’s OWN conversation first, holding what no call tagged', () => {
    const instances = agentInstances(
      engineer([
        {
          id: 'main',
          kind: 'main',
          label: 'Main conversation',
          status: 'completed',
          sessionId: null,
        },
        call('call-1'),
        delegate('own-delegate', null),
      ]),
      [shell('s1', null)],
    );
    expect(instances.map((i) => i.thread.id)).toEqual(['main', 'call-1']);
    expect(instances[0]!.subagents.map((t) => t.id)).toEqual(['own-delegate']);
    expect(instances[0]!.shells.map((s) => s.id)).toEqual(['s1']);
    expect(hasInstanceContent(instances[1]!)).toBe(false);
  });

  it('keeps a call the window has no opening for as its OWN instance, never pooled', () => {
    // The daemon folds every list the run ever wrote, while the call threads
    // come from the loaded window — so an early call can have a list and no
    // `call_started` on screen. Pouring it into another conversation is exactly
    // the mixing this exists to undo.
    const instances = agentInstances(
      engineer([call('call-9')]),
      [],
      [{ threadId: 'call-1', tasks: [task('1')] }],
    );
    expect(instances.map((i) => i.thread.id)).toEqual(['call-1', 'call-9']);
    expect(instances[0]!.thread.label).toBe('call-1');
    // Nothing in it is running, so it has ended — its opening is simply older
    // than the window.
    expect(instances[0]!.thread.status).toBe('completed');
  });

  it('files a CONTINUED conversation’s delegates, commands and lists under its ONE instance', () => {
    // One Engineer briefed once and continued twice: rows tagged with the
    // earlier calls are that same conversation's, not instances of their own.
    const instances = agentInstances(
      engineer([
        { ...call('call-24'), callIds: ['call-22', 'call-23', 'call-24'] },
        delegate('explore', 'call-22'),
        delegate('review', 'call-24'),
      ]),
      [shell('s1', 'call-23')],
      // ONE list per conversation, as `conversationTaskLists` hands it over.
      [{ threadId: 'call-24', tasks: [task('1'), task('2')] }],
    );
    expect(instances.map((i) => i.thread.id)).toEqual(['call-24']);
    const [only] = instances;
    expect(only!.subagents.map((t) => t.id)).toEqual(['explore', 'review']);
    expect(only!.shells.map((s) => s.id)).toEqual(['s1']);
    expect(only!.tasks.map((t) => t.id)).toEqual(['1', '2']);
  });

  it('reads an inferred call as running while something in it still is', () => {
    const instances = agentInstances(engineer([]), [shell('s1', 'call-3')]);
    expect(instances).toHaveLength(1);
    expect(instances[0]!.thread.status).toBe('running');
  });
});

describe('conversationTaskLists', () => {
  it('combines a continued conversation’s lists in CALL order under its latest call, and leaves others apart', () => {
    const chain = ['call-22', 'call-23', 'call-24'];
    const chains = new Map([
      ['call-22', chain],
      ['call-23', chain],
      ['call-24', chain],
      ['call-30', ['call-30']],
    ]);
    const lists = conversationTaskLists(
      [
        // Deliberately out of call order: the later call must still win.
        {
          callId: 'call-24',
          tasks: [{ ...task('1'), status: 'completed' }],
          snapshot: false,
        },
        { callId: null, tasks: [task('9')], snapshot: false },
        { callId: 'call-22', tasks: [task('1'), task('2')], snapshot: true },
        { callId: 'call-30', tasks: [task('1')], snapshot: false },
      ],
      chains,
    );
    expect(lists.map((l) => l.threadId)).toEqual([
      'call-24',
      'main',
      'call-30',
    ]);
    expect(lists[0]!.tasks.map((t) => [t.id, t.status])).toEqual([
      ['1', 'completed'],
      ['2', 'pending'],
    ]);
    expect(lists[2]!.tasks).toHaveLength(1);
  });

  it('a later call’s SNAPSHOT replaces the earlier list rather than keeping what it dropped', () => {
    const chain = ['call-1', 'call-2'];
    const chains = new Map([
      ['call-1', chain],
      ['call-2', chain],
    ]);
    const [list] = conversationTaskLists(
      [
        { callId: 'call-1', tasks: [task('1'), task('2')], snapshot: true },
        {
          callId: 'call-2',
          tasks: [{ ...task('1'), status: 'completed' }],
          snapshot: true,
        },
      ],
      chains,
    );
    expect(list!.threadId).toBe('call-2');
    expect(list!.tasks.map((t) => [t.id, t.status])).toEqual([
      ['1', 'completed'],
    ]);
  });
});

describe('instanceIdentity', () => {
  it('keys a continued conversation by its FIRST call, so a continuation does not remount its block', () => {
    expect(
      instanceIdentity({
        ...call('call-24'),
        callIds: ['call-22', 'call-23', 'call-24'],
      }),
    ).toBe('call-22');
    expect(
      instanceIdentity({
        id: 'main',
        kind: 'main',
        label: 'Main conversation',
        status: 'running',
        sessionId: null,
      }),
    ).toBe('main');
  });
});

describe('isInstanceLive', () => {
  it('keeps a settled call live while its detached command still runs', () => {
    const [instance] = agentInstances(engineer([call('call-1', 'completed')]), [
      shell('s1', 'call-1'),
    ]);
    expect(isInstanceLive(instance!)).toBe(true);
  });

  it('reads a settled call with nothing running inside it as over', () => {
    const [instance] = agentInstances(
      engineer([
        call('call-1', 'failed'),
        delegate('d1', 'call-1', 'completed'),
      ]),
    );
    expect(isInstanceLive(instance!)).toBe(false);
  });
});
