import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  GENIRO_MCP_CALL_TOOLS,
  GENIRO_MCP_SERVER_KEY,
} from '../../adapter.types';
import { CURSOR_PROBE_ECHO_TOOL } from '../cursor.const';
import { buildCursorMcpServerEntry } from './cursor-mcp-entry.utils';
import { mergeGeniroEntry } from './cursor-mcp-file.utils';

const ENDPOINT = {
  url: 'http://127.0.0.1:4870/v1/mcp/run-1/orch',
  token: 'tok-secret',
};

const cwds: string[] = [];
afterEach(() => {
  for (const cwd of cwds.splice(0)) {
    rmSync(cwd, { recursive: true, force: true });
  }
});

function tempCwd(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'cursor-mcp-entry-spec-'));
  cwds.push(cwd);
  return cwd;
}

describe('buildCursorMcpServerEntry', () => {
  it('is exactly the url + bearer header + autoApprove entry, and nothing else', () => {
    const entry = buildCursorMcpServerEntry(ENDPOINT);

    expect(entry).toEqual({
      url: 'http://127.0.0.1:4870/v1/mcp/run-1/orch',
      headers: { Authorization: 'Bearer tok-secret' },
      autoApprove: ['call_agent', 'await_agent', 'answer_agent'],
    });
    // Nothing rides along: an extra key here is a field cursor would honour
    // that no reviewer of this util ever agreed to.
    expect(Object.keys(entry).sort()).toEqual([
      'autoApprove',
      'headers',
      'url',
    ]);
  });

  it('auto-approves EXACTLY the geniro call tools by default — never a wider grant', () => {
    // The bounded trust expansion is the whole point: cursor drops unapproved
    // MCP tools, and the tempting fix (`--approve-mcps`, or listing the user's
    // servers here) would blanket-approve servers geniro does not own. Widening
    // this default by a single name fails here.
    const { autoApprove } = buildCursorMcpServerEntry(ENDPOINT);

    expect(autoApprove).toEqual(['call_agent', 'await_agent', 'answer_agent']);
    // ...and it is the SAME set the endpoint actually serves, so the two can
    // never drift into approving a tool that does not exist (or missing one).
    expect(autoApprove).toEqual([...GENIRO_MCP_CALL_TOOLS]);
  });

  it('carries the bearer token in the entry itself — never on a command line', () => {
    const entry = buildCursorMcpServerEntry(ENDPOINT);

    // `ps` shows argv to every local account, so the token may only travel
    // inside the (0600) config file: an http entry with no launcher at all.
    expect('command' in entry).toBe(false);
    expect('args' in entry).toBe(false);
    expect(entry.headers).toEqual({
      Authorization: `Bearer ${ENDPOINT.token}`,
    });
    // Not in the URL either — that is the one part of an entry cursor echoes
    // back in its own server listings.
    expect(entry.url).not.toContain(ENDPOINT.token);
  });

  it('an explicit autoApprove REPLACES the default rather than adding to it', () => {
    // The trust probe grants the echo tool alone; unioning it with the default
    // would hand a probe run in a daemon-owned temp cwd the real call tools.
    const entry = buildCursorMcpServerEntry(ENDPOINT, [CURSOR_PROBE_ECHO_TOOL]);

    expect(entry.autoApprove).toEqual(['echo']);
  });

  it('copies the caller-supplied list, so a consumer cannot mutate the shared tool set', () => {
    // The default arg is the shared `GENIRO_MCP_CALL_TOOLS` constant; handing
    // it out by reference would let one turn's entry rewrite every later one.
    const entry = buildCursorMcpServerEntry(ENDPOINT);
    entry.autoApprove.push('rm_rf');

    expect([...GENIRO_MCP_CALL_TOOLS]).toEqual([
      'call_agent',
      'await_agent',
      'answer_agent',
    ]);
    expect(buildCursorMcpServerEntry(ENDPOINT).autoApprove).toEqual([
      'call_agent',
      'await_agent',
      'answer_agent',
    ]);
  });

  it('is what lands under the geniro key of a real .cursor/mcp.json', () => {
    // The probe and every real turn share this builder precisely so what the
    // probe proved trustworthy is byte-for-byte what a turn later writes.
    const cwd = tempCwd();
    const entry = buildCursorMcpServerEntry(ENDPOINT);

    expect(mergeGeniroEntry(cwd, entry)).toEqual({ ok: true, created: true });

    const written: unknown = JSON.parse(
      readFileSync(join(cwd, '.cursor', 'mcp.json'), 'utf8'),
    );
    expect(written).toEqual({ mcpServers: { [GENIRO_MCP_SERVER_KEY]: entry } });
    expect(GENIRO_MCP_SERVER_KEY).toBe('geniro');
  });
});
