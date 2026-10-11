import { describe, expect, it } from 'vitest';

import { HOST_FINDINGS_TOOL } from '../chat.types';
import { isHostFindingsCall } from './host-findings';

const SERVER = 'geniro-1a2b3c4d';

describe('isHostFindingsCall', () => {
  it("matches claude's spelling, which wraps the per-run server name", () => {
    // That CLI names an MCP tool `mcp__<server>__<tool>`, and the server it is
    // handed is the per-run one — one of the two exact templates
    // `isHostToolCall` accepts, the other being cursor's measured title.
    expect(
      isHostFindingsCall(SERVER, `mcp__${SERVER}__${HOST_FINDINGS_TOOL}`),
    ).toBe(true);
  });

  it('matches cursor’s measured title, `<server>-<tool>: <tool>`', () => {
    expect(
      isHostFindingsCall(
        SERVER,
        `${SERVER}-${HOST_FINDINGS_TOOL}: ${HOST_FINDINGS_TOOL}`,
      ),
    ).toBe(true);
  });

  it('refuses a BARE tool name — no shipped CLI sends one', () => {
    // Deliberately narrower than the older question tool, whose bare arm is
    // kept because it has been live. An unqualified name names no server, so
    // approving it would approve a tool this app never registered; failing
    // safe here costs a permission card nobody is known to see.
    expect(isHostFindingsCall(SERVER, HOST_FINDINGS_TOOL)).toBe(false);
  });

  it('refuses a same-named tool on somebody else’s server', () => {
    // The whole point of requiring both halves: a user's own MCP server may
    // legitimately expose a tool by this name, and it must not be auto-approved.
    expect(
      isHostFindingsCall(SERVER, `acme-review: ${HOST_FINDINGS_TOOL}`),
    ).toBe(false);
  });

  it('refuses a same-named tool on somebody else’s MCP server', () => {
    expect(isHostFindingsCall(SERVER, 'mcp__acme__report_findings')).toBe(
      false,
    );
  });

  it('refuses a third-party tool that WRAPS this run’s server name', () => {
    // The run id is visible to the model in its own tool namespace, so a server
    // it can reach could name a tool after it. Both spellings are matched
    // exactly for that reason — nothing is ever matched by containment.
    expect(
      isHostFindingsCall(SERVER, `mcp__evil__${SERVER}__${HOST_FINDINGS_TOOL}`),
    ).toBe(false);
  });

  it('refuses every spelling when no host server was minted for this run', () => {
    expect(
      isHostFindingsCall(
        null,
        `${SERVER}-${HOST_FINDINGS_TOOL}: ${HOST_FINDINGS_TOOL}`,
      ),
    ).toBe(false);
    expect(
      isHostFindingsCall(null, `mcp__${SERVER}__${HOST_FINDINGS_TOOL}`),
    ).toBe(false);
  });

  it('does not match geniro’s other host tool', () => {
    expect(isHostFindingsCall(SERVER, `${SERVER}: ask_user_question`)).toBe(
      false,
    );
  });
});
