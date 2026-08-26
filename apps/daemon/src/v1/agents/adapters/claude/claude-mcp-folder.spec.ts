import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AgentEvent, AgentModel } from '../adapter.types';
import { AgentAdapter } from '../agent-adapter';
import { ClaudeAdapter } from './claude.adapter';

let cwd: string;
let homeDir: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'claude-folder-facts-'));
  // An empty stand-in for `~`, so the developer's own
  // `~/.claude/settings.json` can never leak a disabled name into these
  // assertions — the adapter reads it for real in production.
  homeDir = mkdtempSync(join(tmpdir(), 'claude-folder-home-'));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
});

/** The adapter under test, with `~` pointed at an empty directory. */
const adapter = (): ClaudeAdapter => new ClaudeAdapter({ homeDir });

/** Write a file, creating its parent directories. */
function write(rel: string, content: string): void {
  const path = join(cwd, rel);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

describe('ClaudeAdapter.readMcpFolderFacts', () => {
  it('reports nothing off for a folder with no config at all', async () => {
    const facts = await adapter().readMcpFolderFacts(cwd);

    expect(facts.disabled).toEqual([]);
    expect(facts.lockedOff).toEqual([]);
  });

  it('reports a server the user disabled in .claude/settings.json', async () => {
    write(
      '.claude/settings.json',
      JSON.stringify({ disabledMcpjsonServers: ['sentry'] }),
    );

    const facts = await adapter().readMcpFolderFacts(cwd);

    expect(facts.lockedOff).toContain('sentry');
  });

  it('reports a server the user disabled in .claude/settings.local.json', async () => {
    write(
      '.claude/settings.local.json',
      JSON.stringify({ disabledMcpjsonServers: ['docs'] }),
    );

    const facts = await adapter().readMcpFolderFacts(cwd);

    expect(facts.lockedOff).toContain('docs');
  });

  it('unions both project settings files rather than letting one win', async () => {
    // Probe-verified: the CLI unions these lists. Reading only the last file
    // would show a switch for a server the user disabled in the other one,
    // and that switch could never turn it back on.
    write(
      '.claude/settings.json',
      JSON.stringify({ disabledMcpjsonServers: ['from-shared'] }),
    );
    write(
      '.claude/settings.local.json',
      JSON.stringify({ disabledMcpjsonServers: ['from-local'] }),
    );

    const facts = await adapter().readMcpFolderFacts(cwd);

    expect(facts.lockedOff).toEqual(
      expect.arrayContaining(['from-shared', 'from-local']),
    );
  });

  it('does not repeat a name disabled in two files', async () => {
    write(
      '.claude/settings.json',
      JSON.stringify({ disabledMcpjsonServers: ['sentry'] }),
    );
    write(
      '.claude/settings.local.json',
      JSON.stringify({ disabledMcpjsonServers: ['sentry'] }),
    );

    const facts = await adapter().readMcpFolderFacts(cwd);

    expect(facts.lockedOff.filter((n) => n === 'sentry')).toHaveLength(1);
  });

  it('keeps reading the other settings files when one is malformed', async () => {
    write('.claude/settings.json', 'not json');
    write(
      '.claude/settings.local.json',
      JSON.stringify({ disabledMcpjsonServers: ['docs'] }),
    );

    const facts = await adapter().readMcpFolderFacts(cwd);

    expect(facts.lockedOff).toContain('docs');
  });

  it('reports a server the user disabled in ~/.claude/settings.json', async () => {
    // The home arm. Without it, a server disabled GLOBALLY would render with a
    // working switch that can never turn it back on, because the CLI unions
    // the lists — the exact case `userDisabled` exists to prevent.
    mkdirSync(join(homeDir, '.claude'), { recursive: true });
    writeFileSync(
      join(homeDir, '.claude/settings.json'),
      JSON.stringify({ disabledMcpjsonServers: ['from-home'] }),
      'utf8',
    );

    const facts = await adapter().readMcpFolderFacts(cwd);

    expect(facts.lockedOff).toContain('from-home');
  });

  it('unions the home file with the project ones', async () => {
    mkdirSync(join(homeDir, '.claude'), { recursive: true });
    writeFileSync(
      join(homeDir, '.claude/settings.json'),
      JSON.stringify({ disabledMcpjsonServers: ['from-home'] }),
      'utf8',
    );
    write(
      '.claude/settings.json',
      JSON.stringify({ disabledMcpjsonServers: ['from-project'] }),
    );

    const facts = await adapter().readMcpFolderFacts(cwd);

    expect(facts.lockedOff).toEqual(
      expect.arrayContaining(['from-home', 'from-project']),
    );
  });

  it('reports a server the user rejected at the CLI’s own trust prompt', async () => {
    // Answering "No" to claude's "New MCP server found in .mcp.json" prompt is
    // how a user disables a project server in practice, and the CLI records
    // that answer in `~/.claude.json` under `projects[<cwd>]` — NOT in any
    // `settings.json`. Probe-verified live on 2.1.220 in this container: with
    // `projects[<cwd>].enabledMcpjsonServers: ['probeserver']` a real `-p` turn
    // reported `mcp_servers: [{name:'probeserver',status:'pending'}]`; moving
    // the same name to `projects[<cwd>].disabledMcpjsonServers` reported
    // `mcp_servers: []`.
    //
    // Missing this source is the exact failure `userDisabled` exists to
    // prevent: the row renders a live switch reading ON for a server the turn
    // never loads, and flipping it off and back on cannot re-enable it,
    // because the CLI unions the disabled lists.
    writeFileSync(
      join(homeDir, '.claude.json'),
      JSON.stringify({
        projects: { [cwd]: { disabledMcpjsonServers: ['sentry'] } },
      }),
      'utf8',
    );
    write('.mcp.json', JSON.stringify({ mcpServers: { sentry: {} } }));

    const facts = await adapter().readMcpFolderFacts(cwd);

    expect(facts.lockedOff).toContain('sentry');
  });

  it('reads a rejected name alongside the rest', async () => {
    write(
      '.mcp.json',
      JSON.stringify({ mcpServers: { sentry: {}, docs: {} } }),
    );
    write(
      '.claude/settings.json',
      JSON.stringify({ disabledMcpjsonServers: ['docs'] }),
    );

    const facts = await adapter().readMcpFolderFacts(cwd);

    expect(facts.lockedOff).toContain('docs');
  });
});

describe('AgentAdapter.readMcpFolderFacts default', () => {
  it('knows nothing, so every row renders read-only', async () => {
    // The honest answer for a CLI whose config layout is unverified: nothing
    // known means no switches, rather than a control whose effect has never
    // been observed for that CLI. cursor-agent takes this default.
    class Unverified extends AgentAdapter {
      getConfig(): never {
        throw new Error('not needed for this default');
      }
      protected buildArgs(): string[] {
        return [];
      }
      protected mapMessage(): AgentEvent[] {
        return [];
      }
      listModels(): Promise<AgentModel[]> {
        return Promise.resolve([]);
      }
    }

    await expect(
      new Unverified().readMcpFolderFacts('/anywhere'),
    ).resolves.toEqual({
      disabled: [],
      lockedOff: [],
      // Unstated rather than guessed, on the same rule as the two lists above:
      // an adapter that cannot read its CLI's config files cannot place a row's
      // scope, and the panel draws no origin at all rather than a wrong one.
      origins: {},
      interactiveOnlyNote: null,
    });
  });
});
