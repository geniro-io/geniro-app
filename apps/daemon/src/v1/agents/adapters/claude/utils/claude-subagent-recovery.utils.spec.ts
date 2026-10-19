import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { AgentKind } from '../../../../runs/runs.types';
import type { SubagentRecoveryRef } from '../../adapter.types';
import { recoverClaudeSubagent } from './claude-subagent-recovery.utils';

const roots: string[] = [];
const ref: SubagentRecoveryRef = {
  agentKind: AgentKind.Claude,
  sessionId: 'parent-session',
  toolCallId: 'toolu_delegate',
  cwd: '/work',
  configDir: null,
  launchedAtMs: 1,
  childSessionId: null,
};

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function profile(lines: unknown[]): string {
  const root = mkdtempSync(join(tmpdir(), 'claude-subagent-recovery-'));
  roots.push(root);
  const dir = join(root, 'projects', '-work');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${ref.sessionId}.jsonl`),
    lines.map((line) => JSON.stringify(line)).join('\n') + '\n',
  );
  return root;
}

function foreground(
  status = 'completed',
  id = ref.toolCallId,
): Record<string, unknown> {
  return {
    type: 'user',
    timestamp: new Date(30).toISOString(),
    sessionId: ref.sessionId,
    toolUseResult: { status, agentId: 'a123' },
    message: {
      content: [{ type: 'tool_result', tool_use_id: id, content: 'result' }],
    },
  };
}

function notification(
  status: string,
  id = ref.toolCallId,
): Record<string, unknown> {
  return {
    type: 'user',
    timestamp: new Date(30).toISOString(),
    sessionId: ref.sessionId,
    origin: { kind: 'task-notification', producer: 'session-task' },
    promptSource: 'system',
    turnOrigin: 'task_notification',
    message: {
      content: `<task-notification><task-id>a123</task-id><tool-use-id>${id}</tool-use-id><status>${status}</status></task-notification>`,
    },
  };
}

describe('recoverClaudeSubagent', () => {
  it('does not reuse a terminal result from before the current execution', async () => {
    const old = { ...foreground(), timestamp: new Date(10).toISOString() };
    expect(
      await recoverClaudeSubagent(profile([old]), { ...ref, launchedAtMs: 20 }),
    ).toBeNull();
  });
  it('recovers the matching foreground result, including its error outcome', async () => {
    expect(await recoverClaudeSubagent(profile([foreground()]), ref)).toBe(
      'completed',
    );
    const failed = foreground();
    failed.message = {
      content: [
        { type: 'tool_result', tool_use_id: ref.toolCallId, is_error: true },
      ],
    };
    expect(await recoverClaudeSubagent(profile([failed]), ref)).toBe('failed');
  });

  it.each([
    ['completed', 'completed'],
    ['failed', 'failed'],
    ['killed', 'stopped'],
    ['cancelled', 'stopped'],
    ['timeout', 'failed'],
    ['running', null],
  ])(
    'maps the authoritative notification status %s to %s',
    async (status, outcome) => {
      expect(
        await recoverClaudeSubagent(profile([notification(status)]), ref),
      ).toBe(outcome);
    },
  );

  it('uses the latest authoritative matching terminal and ignores unrelated later records', async () => {
    expect(
      await recoverClaudeSubagent(
        profile([
          foreground(),
          notification('failed'),
          notification('completed', 'other'),
          foreground('async_launched', 'other'),
        ]),
        ref,
      ),
    ).toBe('failed');
  });

  it('does not mistake quoted notification XML for a CLI ending', async () => {
    const quoted = notification('completed');
    delete quoted.origin;
    expect(await recoverClaudeSubagent(profile([quoted]), ref)).toBeNull();
  });

  it('invalidates a prior ending when the same launch is working again', async () => {
    expect(
      await recoverClaudeSubagent(
        profile([foreground(), foreground('async_launched')]),
        ref,
      ),
    ).toBeNull();
  });

  it('withholds a previous ending while a later record is malformed or incomplete', async () => {
    const root = profile([foreground()]);
    const path = join(root, 'projects', '-work', `${ref.sessionId}.jsonl`);
    writeFileSync(path, JSON.stringify(foreground()) + '\n{"type":"user",');
    expect(await recoverClaudeSubagent(root, ref)).toBeNull();
  });

  it.each(['origin', 'promptSource', 'turnOrigin'])(
    'requires notification provenance %s',
    async (field) => {
      const line = notification('completed');
      delete line[field];
      expect(await recoverClaudeSubagent(profile([line]), ref)).toBeNull();
    },
  );

  it('rejects mismatching tool ids and an ambiguous multi-result line', async () => {
    const ambiguous = foreground();
    ambiguous.message = {
      content: [
        { type: 'tool_result', tool_use_id: ref.toolCallId },
        { type: 'tool_result', tool_use_id: 'other' },
      ],
    };
    expect(
      await recoverClaudeSubagent(
        profile([
          foreground('completed', 'other'),
          notification('completed', 'other'),
          ambiguous,
        ]),
        ref,
      ),
    ).toBeNull();
  });

  it('rejects duplicate notification ids and another parent session', async () => {
    const duplicate = notification('completed');
    duplicate.message = {
      content: `<task-id>a123</task-id><tool-use-id>${ref.toolCallId}</tool-use-id><tool-use-id>other</tool-use-id><status>completed</status>`,
    };
    const otherSession = foreground();
    otherSession.sessionId = 'other-parent';
    expect(
      await recoverClaudeSubagent(profile([duplicate, otherSession]), ref),
    ).toBeNull();
  });

  it('does not settle async launch, assistant end_turn, or malformed data', async () => {
    expect(
      await recoverClaudeSubagent(
        profile([
          foreground('async_launched'),
          { type: 'assistant', message: { stop_reason: 'end_turn' } },
          {
            type: 'user',
            toolUseResult: { status: 'completed' },
            message: null,
          },
          null,
        ]),
        ref,
      ),
    ).toBeNull();
  });

  it('does not settle missing or truncated parent records', async () => {
    const root = profile([]);
    const path = join(root, 'projects', '-work', `${ref.sessionId}.jsonl`);
    writeFileSync(path, '{"type":"user",');
    expect(await recoverClaudeSubagent(root, ref)).toBeNull();
    rmSync(path);
    expect(await recoverClaudeSubagent(root, ref)).toBeNull();
  });

  it.each(['sessionId', 'toolCallId'] as const)(
    'refuses traversal in %s even with a terminal record',
    async (field) => {
      const root = profile([foreground()]);
      expect(
        await recoverClaudeSubagent(root, {
          ...ref,
          [field]: '../parent-session',
        }),
      ).toBeNull();
    },
  );
});
