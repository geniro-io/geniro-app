import { homedir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { AgentKind } from '../../runs/runs.types';
import { freshVocabularyStore } from '../adapters/__tests__/fresh-vocabulary-store';
import type { AgentAdapter } from '../adapters/agent-adapter';
import { ClaudeAdapter } from '../adapters/claude/claude.adapter';
import { CodexAdapter } from '../adapters/codex/codex.adapter';
import { CursorAcpAdapter } from '../adapters/cursor-acp/cursor-acp.adapter';
import type { AgentAdapterRegistry } from '../services/agent-adapter.registry';
import { userInstructionFiles } from './user-instruction-files';

const adapters: Record<AgentKind, AgentAdapter> = {
  claude: new ClaudeAdapter(),
  codex: new CodexAdapter({ clientVersion: '1.0.0' }),
  'cursor-agent': new CursorAcpAdapter({
    vocabularyStore: freshVocabularyStore(),
  }),
};
const registry = {
  for: (kind: AgentKind) => adapters[kind],
} as unknown as AgentAdapterRegistry;

describe('userInstructionFiles', () => {
  it("resolves each CLI's file under the run's profile, else its default home", () => {
    expect(
      userInstructionFiles(registry, [
        { agent: 'claude', configDir: null },
        { agent: 'claude', configDir: '/profiles/work' },
        { agent: 'codex', configDir: null },
      ]),
    ).toEqual([
      {
        agent: 'claude',
        configDir: null,
        path: join(homedir(), '.claude', 'CLAUDE.md'),
      },
      {
        agent: 'claude',
        configDir: '/profiles/work',
        path: '/profiles/work/CLAUDE.md',
      },
      {
        agent: 'codex',
        configDir: null,
        path: join(homedir(), '.codex', 'AGENTS.md'),
      },
    ]);
  });

  it('names no path, and says why, for a CLI that keeps no such file', () => {
    const [cursor] = userInstructionFiles(registry, [
      { agent: 'cursor-agent', configDir: null },
    ]);

    expect(cursor).toMatchObject({ agent: 'cursor-agent', path: null });
    expect(cursor!.unavailableReason).toMatch(/account setting/);
  });

  it('lists an agent and profile a workflow ran twice only once', () => {
    expect(
      userInstructionFiles(registry, [
        { agent: 'codex', configDir: '/p' },
        { agent: 'claude', configDir: null },
        { agent: 'codex', configDir: '/p' },
      ]).map((file) => file.agent),
    ).toEqual(['codex', 'claude']);
  });
});
