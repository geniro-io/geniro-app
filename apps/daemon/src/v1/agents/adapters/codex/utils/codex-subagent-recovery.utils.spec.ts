import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AgentKind } from '../../../../runs/runs.types';
import type { SubagentRecoveryRef } from '../../adapter.types';
import { CODEX_RECOVERY_MAX_BYTES } from '../codex.const';
import { recoverCodexSubagent } from './codex-subagent-recovery.utils';

const childId = '019e64c7-aaaa-7111-8999-123456789abc';
const parentId = '019e64c7-bbbb-7111-8999-123456789abc';
const launch = Date.parse('2026-10-19T10:00:00.000Z');

function event(type: string, turnId = 'turn-1', seconds = 1, reason?: string) {
  return {
    timestamp: new Date(launch + seconds * 1000).toISOString(),
    type: 'event_msg',
    payload: { type, turn_id: turnId, ...(reason ? { reason } : {}) },
  };
}

function metadata(parent = parentId, id = childId) {
  return {
    type: 'session_meta',
    payload: {
      id,
      source: { subagent: { thread_spawn: { parent_thread_id: parent } } },
    },
  };
}

describe('recoverCodexSubagent', () => {
  let home: string;
  let path: string;
  let ref: SubagentRecoveryRef;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'codex-recovery-'));
    path = join(
      home,
      'sessions',
      '2026',
      '10',
      '19',
      `rollout-${childId}.jsonl`,
    );
    ref = {
      agentKind: AgentKind.Codex,
      sessionId: parentId,
      cwd: home,
      configDir: home,
      toolCallId: 'spawn-1',
      launchedAtMs: launch,
      childSessionId: childId,
    };
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  async function write(rows: unknown[], suffix = '\n') {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      rows.map((row) => JSON.stringify(row)).join('\n') + suffix,
    );
  }

  it('recovers a completion for the latest started turn', async () => {
    await write([
      metadata(),
      event('task_started'),
      event('task_complete'),
      event('task_started', 'turn-2', 2),
      event('task_complete', 'turn-2', 3),
    ]);
    expect(await recoverCodexSubagent(ref, home)).toBe('completed');
  });

  it('withholds an older completion after a newer start', async () => {
    await write([
      metadata(),
      event('task_started'),
      event('task_complete'),
      event('task_started', 'turn-2', 2),
    ]);
    expect(await recoverCodexSubagent(ref, home)).toBeNull();
  });

  it('requires the terminal record to name the latest turn', async () => {
    await write([
      metadata(),
      event('task_started', 'turn-2'),
      event('task_complete', 'turn-1'),
    ]);
    expect(await recoverCodexSubagent(ref, home)).toBeNull();
  });

  it.each([
    metadata(childId),
    metadata(parentId, parentId),
    { type: 'session_meta', payload: { id: childId } },
  ])(
    'refuses a mismatched or missing parent/child identity: %j',
    async (meta) => {
      await write([meta, event('task_started'), event('task_complete')]);
      expect(await recoverCodexSubagent(ref, home)).toBeNull();
    },
  );

  it('does not infer failure from an error row', async () => {
    await write([metadata(), event('task_started'), event('error')]);
    expect(await recoverCodexSubagent(ref, home)).toBeNull();
  });

  it('recovers an explicitly interrupted turn', async () => {
    await write([
      metadata(),
      event('task_started'),
      event('turn_aborted', 'turn-1', 2, 'interrupted'),
    ]);
    expect(await recoverCodexSubagent(ref, home)).toBe('stopped');
  });

  it('withholds an unrecognized abortion reason', async () => {
    await write([
      metadata(),
      event('task_started'),
      event('turn_aborted', 'turn-1', 2, 'unknown'),
    ]);
    expect(await recoverCodexSubagent(ref, home)).toBeNull();
  });

  it('withholds completions predating the launch', async () => {
    await write([
      metadata(),
      event('task_started', 'turn-1', -2),
      event('task_complete', 'turn-1', -1),
    ]);
    expect(await recoverCodexSubagent(ref, home)).toBeNull();
  });

  it('leaves a missing rollout unknown', async () => {
    expect(await recoverCodexSubagent(ref, home)).toBeNull();
  });

  it.each(['', '\n{"type":"event_msg"', '\n{bad}\n'])(
    'withholds a potentially truncated continuation: %j',
    async (suffix) => {
      await write(
        [metadata(), event('task_started'), event('task_complete')],
        suffix,
      );
      expect(await recoverCodexSubagent(ref, home)).toBeNull();
    },
  );

  it.each([null, '../escape', 'not-a-uuid'])(
    'guards the child identifier %s',
    async (id) => {
      await write([metadata(), event('task_started'), event('task_complete')]);
      expect(
        await recoverCodexSubagent({ ...ref, childSessionId: id }, home),
      ).toBeNull();
    },
  );

  it('guards the parent identifier', async () => {
    expect(
      await recoverCodexSubagent({ ...ref, sessionId: '../escape' }, home),
    ).toBeNull();
  });

  it('reads archived rollouts', async () => {
    path = join(home, 'archived_sessions', `rollout-${childId}.jsonl`);
    await write([metadata(), event('task_started'), event('task_complete')]);
    expect(await recoverCodexSubagent(ref, home)).toBe('completed');
  });

  it('refuses conflicting duplicate rollouts', async () => {
    await write([metadata(), event('task_started'), event('task_complete')]);
    path = join(home, 'archived_sessions', `rollout-${childId}.jsonl`);
    await write([metadata(), event('task_started')]);
    expect(await recoverCodexSubagent(ref, home)).toBeNull();
  });

  it('does not follow a store symlink outside the selected home', async () => {
    path = join(home, 'outside', `rollout-${childId}.jsonl`);
    await write([metadata(), event('task_started'), event('task_complete')]);
    const profile = join(home, 'profile');
    await mkdir(profile);
    await symlink(dirname(path), join(profile, 'sessions'));
    expect(await recoverCodexSubagent(ref, profile)).toBeNull();
  });

  it('does not follow a rollout symlink', async () => {
    path = join(home, 'outside', `rollout-${childId}.jsonl`);
    await write([metadata(), event('task_started'), event('task_complete')]);
    await mkdir(join(home, 'sessions'));
    await symlink(path, join(home, 'sessions', `rollout-${childId}.jsonl`));
    expect(await recoverCodexSubagent(ref, home)).toBeNull();
  });

  it('bounds the rollout read', async () => {
    await write([
      metadata(),
      event('task_started'),
      {
        type: 'event_msg',
        payload: {
          type: 'noop',
          padding: 'x'.repeat(CODEX_RECOVERY_MAX_BYTES),
        },
      },
      event('task_complete'),
    ]);
    expect(await recoverCodexSubagent(ref, home)).toBeNull();
  });
});
