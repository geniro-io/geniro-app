import { describe, expect, it } from 'vitest';

import type { AgentDisplay, AgentThread } from './agent-activity';
import {
  agentInstances,
  hasInstanceContent,
  isInstanceLive,
} from './agent-instances';
import type { ShellRun } from './shell-activity';
import type { AgentTaskRow } from './task-payload';

const call = (
  id: string,
  status: AgentThread['status'] = 'running',
): AgentThread => ({
  id,
  kind: 'call',
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

  it('reads an inferred call as running while something in it still is', () => {
    const instances = agentInstances(engineer([]), [shell('s1', 'call-3')]);
    expect(instances).toHaveLength(1);
    expect(instances[0]!.thread.status).toBe('running');
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
