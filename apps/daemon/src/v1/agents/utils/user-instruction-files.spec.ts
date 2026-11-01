import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AgentKind } from '../../runs/runs.types';
import { freshVocabularyStore } from '../adapters/__tests__/fresh-vocabulary-store';
import type { AgentAdapter } from '../adapters/agent-adapter';
import { ClaudeAdapter } from '../adapters/claude/claude.adapter';
import { CodexAdapter } from '../adapters/codex/codex.adapter';
import { CursorAcpAdapter } from '../adapters/cursor-acp/cursor-acp.adapter';
import type { AgentAdapterRegistry } from '../services/agent-adapter.registry';
import {
  sizedUserInstructionFiles,
  userInstructionFiles,
} from './user-instruction-files';

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

  it('lists an agent and profile a team ran twice only once', () => {
    expect(
      userInstructionFiles(registry, [
        { agent: 'codex', configDir: '/p' },
        { agent: 'claude', configDir: null },
        { agent: 'codex', configDir: '/p' },
      ]).map((file) => file.agent),
    ).toEqual(['codex', 'claude']);
  });
});

describe('sizedUserInstructionFiles', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'geniro-user-rules-'));
  });

  afterEach(async () => {
    await chmod(join(dir, 'locked'), 0o755).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  });

  /** Each profile directory's own claude file, measured. */
  async function sized(...configDirs: string[]) {
    return sizedUserInstructionFiles(
      registry,
      configDirs.map((configDir) => ({ agent: 'claude' as const, configDir })),
    );
  }

  it('measures a file as it stands, its own length only', async () => {
    await mkdir(join(dir, 'work'));
    await writeFile(
      join(dir, 'work', 'CLAUDE.md'),
      `@AGENTS.md\n${'é'.repeat(30)}`,
    );

    expect(await sized(join(dir, 'work'))).toEqual([
      expect.objectContaining({ exists: true, chars: 41, approxTokens: 11 }),
    ]);
  });

  it('says a missing file is missing, and measures no file a CLI keeps none of', async () => {
    const [missing] = await sized(join(dir, 'nowhere'));
    const [cursor] = await sizedUserInstructionFiles(registry, [
      { agent: 'cursor-agent', configDir: null },
    ]);

    expect(missing).toMatchObject({ exists: false, chars: null });
    expect(cursor).toMatchObject({ path: null, exists: null, chars: null });
  });

  it('measures nothing it cannot read, saying whether it is there', async () => {
    await mkdir(join(dir, 'folder', 'CLAUDE.md'), { recursive: true });
    await mkdir(join(dir, 'huge'));
    await writeFile(
      join(dir, 'huge', 'CLAUDE.md'),
      'x'.repeat(1024 * 1024 + 1),
    );
    await mkdir(join(dir, 'unreadable'));
    await writeFile(join(dir, 'unreadable', 'CLAUDE.md'), 'secret rules');
    await chmod(join(dir, 'unreadable', 'CLAUDE.md'), 0o000);
    await mkdir(join(dir, 'locked'));
    await chmod(join(dir, 'locked'), 0o000);

    const [folder, huge, unreadable, locked] = await sized(
      join(dir, 'folder'),
      join(dir, 'huge'),
      join(dir, 'unreadable'),
      join(dir, 'locked'),
    );

    expect(folder).toMatchObject({ exists: false, chars: null });
    expect(huge).toMatchObject({
      exists: true,
      chars: null,
      approxTokens: null,
    });
    expect(unreadable).toMatchObject({ exists: true, chars: null });
    expect(locked).toMatchObject({ exists: null, chars: null });
  });
});
