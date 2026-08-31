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

import { GENIRO_MCP_TOOL_TIMEOUT_MS } from '../claude.const';
import {
  sweepStaleTurnMcpConfigs,
  writeTurnMcpConfig,
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
  serverName: 'geniro-run-1',
};

describe('writeTurnMcpConfig', () => {
  it('writes the endpoint as an http MCP server the CLI can reach', () => {
    const path = writeTurnMcpConfig(tempDir(), ENDPOINT);

    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      mcpServers: {
        // The endpoint's own per-run name: the user's servers load beside
        // this one, so a shared key could shadow one of theirs.
        [ENDPOINT.serverName]: {
          type: 'http',
          url: ENDPOINT.url,
          headers: { Authorization: `Bearer ${ENDPOINT.token}` },
          timeout: GENIRO_MCP_TOOL_TIMEOUT_MS,
        },
      },
    });
  });

  it('gives its own tools a timeout a HUMAN can outlast', () => {
    // The reported "timed out again", on a question card still on screen
    // waiting to be answered. Every host tool that parks on a person is served
    // by holding the POST open, so the CLI's per-call limit is what expires
    // them — and `timeout` is that limit, read off its own schema.
    //
    // Asserted as a FLOOR rather than the exact constant: the number is a
    // judgement about how long somebody might be away, and a spec that pinned
    // it would fail on every re-judgement while catching nothing. What must not
    // regress is the ORDER OF MAGNITUDE — a value in minutes is the defect.
    const config: unknown = JSON.parse(
      readFileSync(writeTurnMcpConfig(tempDir(), ENDPOINT), 'utf8'),
    );
    const server = (
      config as { mcpServers: Record<string, { timeout?: number }> }
    ).mcpServers[ENDPOINT.serverName];
    expect(server?.timeout).toBeGreaterThanOrEqual(60 * 60 * 1000);
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

  it('creates that dir 0700, not the 0755 mkdirSync defaults to', () => {
    // The file is already 0600, but the DIRECTORY sits at a predictable path
    // under the OS tmpdir. World-readable, it lets any local account list the
    // turns geniro has live and when each started — a smaller leak than the
    // token, and one that costs a single option to close.
    const dir = join(tempDir(), 'fresh');

    writeTurnMcpConfig(dir, ENDPOINT);

    expect(statSync(dir).mode & 0o777).toBe(0o700);
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
