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
  it('reports the project .mcp.json server names as project scope', async () => {
    write(
      '.mcp.json',
      JSON.stringify({ mcpServers: { sentry: {}, docs: {} } }),
    );

    const facts = await adapter().readMcpFolderFacts(cwd);

    expect(facts.projectServers).toEqual(['sentry', 'docs']);
  });

  it('reports no project servers for a folder with no .mcp.json', async () => {
    const facts = await adapter().readMcpFolderFacts(cwd);

    expect(facts.projectServers).toEqual([]);
    expect(facts.userDisabled).toEqual([]);
  });

  it('does not throw when .mcp.json is malformed', async () => {
    // A broken file in the user's own repo must degrade to "no project
    // servers" — every row then renders read-only — never fail the listing.
    write('.mcp.json', '{ "mcpServers": ');

    const facts = await adapter().readMcpFolderFacts(cwd);

    expect(facts.projectServers).toEqual([]);
  });

  it('does not throw when .mcp.json is a directory', async () => {
    mkdirSync(join(cwd, '.mcp.json'));

    await expect(adapter().readMcpFolderFacts(cwd)).resolves.toEqual({
      projectServers: [],
      userDisabled: [],
    });
  });

  it('reports a server the user disabled in .claude/settings.json', async () => {
    write(
      '.claude/settings.json',
      JSON.stringify({ disabledMcpjsonServers: ['sentry'] }),
    );

    const facts = await adapter().readMcpFolderFacts(cwd);

    expect(facts.userDisabled).toContain('sentry');
  });

  it('reports a server the user disabled in .claude/settings.local.json', async () => {
    write(
      '.claude/settings.local.json',
      JSON.stringify({ disabledMcpjsonServers: ['docs'] }),
    );

    const facts = await adapter().readMcpFolderFacts(cwd);

    expect(facts.userDisabled).toContain('docs');
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

    expect(facts.userDisabled).toEqual(
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

    expect(facts.userDisabled.filter((n) => n === 'sentry')).toHaveLength(1);
  });

  it('keeps reading the other settings files when one is malformed', async () => {
    write('.claude/settings.json', 'not json');
    write(
      '.claude/settings.local.json',
      JSON.stringify({ disabledMcpjsonServers: ['docs'] }),
    );

    const facts = await adapter().readMcpFolderFacts(cwd);

    expect(facts.userDisabled).toContain('docs');
  });

  it('reads project servers and user-disabled names together', async () => {
    write(
      '.mcp.json',
      JSON.stringify({ mcpServers: { sentry: {}, docs: {} } }),
    );
    write(
      '.claude/settings.json',
      JSON.stringify({ disabledMcpjsonServers: ['docs'] }),
    );

    const facts = await adapter().readMcpFolderFacts(cwd);

    expect(facts.projectServers).toEqual(['sentry', 'docs']);
    expect(facts.userDisabled).toContain('docs');
  });
});

describe('AgentAdapter.readMcpFolderFacts default', () => {
  it('knows nothing, so every row renders read-only', async () => {
    // The honest answer for a CLI whose config layout is unverified: no
    // project servers means no switches, rather than a control whose effect
    // has never been observed for that CLI. cursor-agent takes this default,
    // which is what keeps milestone 2 out of its way.
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
    ).resolves.toEqual({ projectServers: [], userDisabled: [] });
  });
});
