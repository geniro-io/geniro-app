import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { fakeSpawn } from '../__tests__/fake-child';
import { mapEventToItem } from '../utils/event-to-item';
import { freshVocabularyStore } from './__tests__/fresh-vocabulary-store';
import type { AgentEvent, SubagentRecoveryRef } from './adapter.types';
import { ClaudeAdapter } from './claude/claude.adapter';
import { CursorAcpAdapter } from './cursor-acp/cursor-acp.adapter';
import { cursorProjectKey } from './cursor-acp/utils/cursor-delegate-transcript.utils';

describe('durable subagent recovery identity', () => {
  it('records a foreground native task identity before its launching call returns', async () => {
    const { spawn, child } = fakeSpawn();
    const events: AgentEvent[] = [];
    const adapter = new ClaudeAdapter({ spawn });
    const input = {
      prompt: 'review',
      cwd: '/project',
      configDir: '/profile',
      internalProbe: true,
    };
    const session = adapter.startSession(input, { runScoped: true });
    const turn = session.startTurn(input, (event) => events.push(event));
    try {
      child.stdout.emitData(
        `${JSON.stringify({ type: 'system', subtype: 'init', session_id: 'parent' })}\n`,
      );
      child.stdout.emitData(
        `${JSON.stringify({ type: 'system', subtype: 'task_started', task_id: 'native-child', task_type: 'local_agent', tool_use_id: 'tool-child', is_backgrounded: false })}\n`,
      );
      const declaration = events.find(
        (event) =>
          event.type === 'subagent_info' && event.recovery !== undefined,
      );
      expect(declaration).toMatchObject({
        type: 'subagent_info',
        id: 'tool-child',
        backgroundOpen: null,
        backgroundOutcome: null,
        recovery: {
          agentKind: 'claude',
          sessionId: 'parent',
          configDir: '/profile',
          cwd: '/project',
          toolCallId: 'tool-child',
          launchedAtMs: expect.any(Number),
          childSessionId: null,
        },
      });
      expect(events.some((event) => event.type === 'tool_result')).toBe(false);
      expect(mapEventToItem(declaration!)?.payload.recovery).toEqual(
        expect.objectContaining({
          sessionId: 'parent',
          toolCallId: 'tool-child',
          configDir: '/profile',
        }),
      );
      const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10_000);
      try {
        child.stdout.emitData(
          `${JSON.stringify({ type: 'system', subtype: 'task_started', task_id: 'native-child', task_type: 'local_agent', tool_use_id: 'tool-child', is_backgrounded: false })}\n`,
        );
        const resumed = events
          .filter(
            (event) =>
              event.type === 'subagent_info' && event.recovery !== undefined,
          )
          .at(-1);
        expect(resumed).toMatchObject({
          recovery: { launchedAtMs: Date.now() },
        });
      } finally {
        now.mockRestore();
      }
    } finally {
      child.emit('close', 0, null);
      await turn?.done;
      await session.closed;
    }
  });
});

describe('CursorAcpAdapter recovery', () => {
  it('reads only an explicitly identified child terminal and keeps unfinished or unidentified children unknown', async () => {
    const home = await mkdtemp(join(tmpdir(), 'cursor-subagent-recovery-'));
    const ref: SubagentRecoveryRef = {
      agentKind: 'cursor-agent',
      sessionId: 'parent',
      toolCallId: 'launch',
      cwd: '/project',
      configDir: null,
      // A file's mtime comes from the kernel's coarse clock and can read a few ms behind Date.now().
      launchedAtMs: Date.now() - 1_000,
      childSessionId: 'child',
    };
    const directory = join(
      home,
      '.cursor',
      'projects',
      cursorProjectKey(ref.cwd),
      'agent-transcripts',
      'child',
    );
    const adapter = new CursorAcpAdapter({
      homeDir: home,
      vocabularyStore: freshVocabularyStore(),
    });
    try {
      await mkdir(directory, { recursive: true });
      const path = join(directory, 'child.jsonl');
      await writeFile(
        path,
        `${JSON.stringify({ role: 'assistant', message: { content: [{ type: 'text', text: 'still working' }] } })}\n`,
      );
      expect(await adapter.recoverSubagent(ref)).toBeNull();
      for (const [status, outcome] of [
        ['success', 'completed'],
        ['error', 'failed'],
        ['aborted', 'stopped'],
      ] as const) {
        await writeFile(
          path,
          `${JSON.stringify({ type: 'turn_ended', status })}\n`,
        );
        expect(await adapter.recoverSubagent(ref)).toBe(outcome);
      }
      expect(
        await adapter.recoverSubagent({ ...ref, childSessionId: null }),
      ).toBeNull();
      expect(
        await adapter.recoverSubagent({
          ...ref,
          launchedAtMs: Date.now() + 60_000,
        }),
      ).toBeNull();
      expect(
        await adapter.recoverSubagent({ ...ref, childSessionId: '../child' }),
      ).toBeNull();
      expect(
        await adapter.recoverSubagent({ ...ref, childSessionId: 'absent' }),
      ).toBeNull();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
