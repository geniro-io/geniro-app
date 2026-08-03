import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  sweepStaleTurnMcpConfigs,
  sweepStaleTurnSettings,
  writeTurnMcpConfig,
  writeTurnSettings,
} from './claude-mcp-config.utils';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'claude-mcp-config-'));
  dirs.push(dir);
  return dir;
}

const ENDPOINT = {
  url: 'http://127.0.0.1:4870/v1/mcp/run-1/orch',
  token: 'call-token-1',
};

describe('writeTurnMcpConfig', () => {
  it('writes the endpoint as an http MCP server the CLI can reach', () => {
    const path = writeTurnMcpConfig(tempDir(), ENDPOINT);

    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      mcpServers: {
        geniro: {
          type: 'http',
          url: ENDPOINT.url,
          headers: { Authorization: `Bearer ${ENDPOINT.token}` },
        },
      },
    });
  });

  it('writes the token-bearing file 0600 — argv would show it to every account', () => {
    // The whole reason the endpoint is a FILE and not a flag: `ps` is readable
    // by every local user, so a token on argv is a token given away.
    const path = writeTurnMcpConfig(tempDir(), ENDPOINT);

    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('creates the config dir when the daemon has not made it yet', () => {
    const dir = join(tempDir(), 'not', 'made', 'yet');

    const path = writeTurnMcpConfig(dir, ENDPOINT);

    expect(existsSync(path)).toBe(true);
  });

  it('names each turn its own file, so two live turns never share one', () => {
    const dir = tempDir();

    const first = writeTurnMcpConfig(dir, ENDPOINT);
    const second = writeTurnMcpConfig(dir, ENDPOINT);

    expect(first).not.toBe(second);
    expect(readdirSync(dir)).toHaveLength(2);
  });
});

describe('sweepStaleTurnMcpConfigs', () => {
  it('removes the config files a killed launch left behind', () => {
    const dir = tempDir();
    const stale = writeTurnMcpConfig(dir, ENDPOINT);

    sweepStaleTurnMcpConfigs(dir);

    expect(existsSync(stale)).toBe(false);
  });

  it('touches nothing else in the directory', () => {
    // The dir is the daemon's own tmp dir, shared with whatever else lives
    // there — a sweep that deleted by directory rather than by name would take
    // an unrelated file with it.
    const dir = tempDir();
    const stale = writeTurnMcpConfig(dir, ENDPOINT);
    const bystander = join(dir, 'notes.json');
    writeFileSync(bystander, '{}');

    sweepStaleTurnMcpConfigs(dir);

    expect(existsSync(stale)).toBe(false);
    expect(existsSync(bystander)).toBe(true);
  });

  it('is a no-op on a directory that does not exist yet', () => {
    // Runs at boot, before any turn has made the dir — a throw here would fail
    // the whole daemon launch over hygiene.
    expect(() =>
      sweepStaleTurnMcpConfigs(join(tempDir(), 'never', 'created')),
    ).not.toThrow();
  });
});

describe('sweepStaleTurnSettings', () => {
  it('removes a settings file a crashed launch left behind', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sweep-settings-'));
    const stale = writeTurnSettings(dir, ['sentry'])!;

    sweepStaleTurnSettings(dir);

    expect(existsSync(stale)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it('leaves a file it did not write', () => {
    // The sweep runs at boot over a shared dir; deleting by directory rather
    // than by name prefix would take the user's files with it.
    const dir = mkdtempSync(join(tmpdir(), 'sweep-settings-'));
    const foreign = join(dir, 'not-ours.json');
    writeFileSync(foreign, '{}', 'utf8');

    sweepStaleTurnSettings(dir);

    expect(existsSync(foreign)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('tolerates a directory that does not exist', () => {
    expect(() =>
      sweepStaleTurnSettings(join(tmpdir(), 'sweep-settings-absent-xyz')),
    ).not.toThrow();
  });
});
