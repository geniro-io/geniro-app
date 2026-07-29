import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type {
  AgentEvent,
  AgentTurnHandle,
  AgentTurnInput,
} from '../adapter.types';
import { probeClaudeCommands } from './claude-commands';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** Records the turns it is asked to run and replays a scripted stream. */
class ScriptedTurns {
  readonly turns: AgentTurnInput[] = [];
  cancelled = 0;
  /** The probe cwd as it existed while the turn was live. */
  cwdExistedDuringTurn: boolean | null = null;

  constructor(
    private readonly script: (
      emit: (event: AgentEvent) => void,
      exit: () => void,
    ) => void,
  ) {}

  readonly start = (
    input: AgentTurnInput,
    onEvent: (event: AgentEvent) => void,
  ): AgentTurnHandle => {
    this.turns.push(input);
    this.cwdExistedDuringTurn = existsSync(input.cwd);
    let settle!: () => void;
    const done = new Promise<void>((resolve) => {
      settle = resolve;
    });
    // Emit asynchronously, as a real stdout stream would.
    setTimeout(() => this.script(onEvent, settle), 0);
    return {
      done,
      cancel: () => {
        this.cancelled += 1;
        settle();
      },
      respondApproval: () => false,
    };
  };
}

const reports = (commands: string[]): ScriptedTurns =>
  new ScriptedTurns((emit) => emit({ type: 'slash_commands', commands }));

describe('probeClaudeCommands', () => {
  it('returns the commands the CLI reported about itself', async () => {
    const turns = reports(['clear', 'compact', 'geniro:review']);

    await expect(
      probeClaudeCommands({
        start: turns.start,
        probeRootDir: tempDir('probe-root-'),
      }),
    ).resolves.toEqual(['clear', 'compact', 'geniro:review']);
  });

  it("drops claude's internal `_`-prefixed commands", async () => {
    // `__remote-workflow` is reported but is not something a user invokes —
    // offering it in the autocomplete would be a dead row.
    const turns = reports(['clear', '__remote-workflow', '_hidden', 'compact']);

    await expect(
      probeClaudeCommands({
        start: turns.start,
        probeRootDir: tempDir('probe-root-'),
      }),
    ).resolves.toEqual(['clear', 'compact']);
  });

  it('cancels the turn the moment the list lands, before the model runs', async () => {
    // The whole point of probing this way: init carries the list, so paying
    // for the rest of the turn buys nothing.
    const turns = reports(['clear']);

    await probeClaudeCommands({
      start: turns.start,
      probeRootDir: tempDir('probe-root-'),
    });

    expect(turns.cancelled).toBe(1);
  });

  it('runs in a throwaway workspace under the given root, and removes it', async () => {
    const probeRootDir = tempDir('probe-root-');
    const turns = reports(['clear']);

    await probeClaudeCommands({ start: turns.start, probeRootDir });

    const cwd = turns.turns[0]?.cwd ?? '';
    expect(cwd.startsWith(probeRootDir)).toBe(true);
    expect(turns.cwdExistedDuringTurn).toBe(true);
    expect(existsSync(cwd)).toBe(false);
    expect(readdirSync(probeRootDir)).toEqual([]);
  });

  it('asks for no permission bypass — the turn never reaches a tool', async () => {
    const turns = reports(['clear']);

    await probeClaudeCommands({
      start: turns.start,
      probeRootDir: tempDir('probe-root-'),
    });

    expect(turns.turns[0]?.approvalMode).toBeUndefined();
    expect(turns.turns[0]?.mcpEndpoint).toBeUndefined();
  });

  it('reports nothing when the CLI exits before its init line', async () => {
    // A missing binary or a failed sign-in ends the turn with no report; the
    // caller falls back to the disk scan rather than surfacing an error.
    const turns = new ScriptedTurns((_emit, exit) => exit());

    await expect(
      probeClaudeCommands({
        start: turns.start,
        probeRootDir: tempDir('probe-root-'),
      }),
    ).resolves.toEqual([]);
  });

  it('reports nothing when the turn cannot be started at all', async () => {
    await expect(
      probeClaudeCommands({
        start: () => {
          throw new Error('spawn ENOENT');
        },
        probeRootDir: tempDir('probe-root-'),
      }),
    ).resolves.toEqual([]);
  });

  it('gives up on a turn that never reports, rather than hanging forever', async () => {
    // A CLI that dropped into an interactive login holds the turn open; the
    // timeout must cancel it so the autocomplete read still completes.
    const turns = new ScriptedTurns(() => {
      // Neither reports nor exits.
    });

    await expect(
      probeClaudeCommands(
        { start: turns.start, probeRootDir: tempDir('probe-root-') },
        { timeoutMs: 10 },
      ),
    ).resolves.toEqual([]);
    expect(turns.cancelled).toBe(1);
  });

  it('hands the turn to onTurn so it can be reaped on shutdown', async () => {
    // Every child the daemon spawns must be registered — a probe turn is no
    // exception, and start() hands back a handle rather than a child.
    const turns = reports(['clear']);
    const registered: AgentTurnHandle[] = [];

    await probeClaudeCommands(
      { start: turns.start, probeRootDir: tempDir('probe-root-') },
      { onTurn: (handle) => registered.push(handle) },
    );

    expect(registered.length).toBe(1);
  });
});
