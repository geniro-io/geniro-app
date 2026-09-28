import { describe, expect, it } from 'vitest';

import { parseCodexMcpList } from './codex-mcp.utils';

/** Rows shaped as `codex mcp list --json` prints them (0.157.1). */
const LISTING = JSON.stringify([
  {
    name: 'computer-use',
    enabled: false,
    disabled_reason: null,
    transport: {
      type: 'stdio',
      command: './SkyComputerUseClient',
      args: ['mcp'],
      env: { SECRET_TOKEN: 'must-never-surface' },
      env_vars: [],
      cwd: '.',
    },
    startup_timeout_sec: null,
    tool_timeout_sec: null,
    auth_status: 'unsupported',
  },
  {
    name: 'linear',
    enabled: true,
    disabled_reason: null,
    transport: { type: 'streamable_http', url: 'https://mcp.linear.app/mcp' },
    auth_status: 'not_logged_in',
  },
  {
    name: 'fs',
    enabled: true,
    transport: { type: 'stdio', command: 'npx' },
    auth_status: 'unsupported',
  },
]);

describe('parseCodexMcpList', () => {
  it('reads each server’s transport, target and configured state', () => {
    expect(parseCodexMcpList(LISTING)).toEqual([
      {
        name: 'computer-use',
        target: './SkyComputerUseClient',
        transport: 'stdio',
        status: 'disabled',
        detail: null,
      },
      {
        name: 'linear',
        target: 'https://mcp.linear.app/mcp',
        transport: 'http',
        status: 'needs_auth',
        detail: null,
      },
      {
        name: 'fs',
        target: 'npx',
        transport: 'stdio',
        status: 'unknown',
        detail: null,
      },
    ]);
  });

  it('never carries a server’s environment into a row', () => {
    expect(JSON.stringify(parseCodexMcpList(LISTING))).not.toContain(
      'must-never-surface',
    );
  });

  it('answers null for output that is not the listing', () => {
    expect(parseCodexMcpList('Error: not logged in')).toBeNull();
    expect(parseCodexMcpList('{"name":"x"}')).toBeNull();
  });
});
