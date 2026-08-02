import { execFile } from 'node:child_process';

import { AgentKind } from '../../../../runs/runs.types';
import { resolveAgentBinary } from '../../../utils/agent-binary';
import { buildChildEnv } from '../../../utils/child-env';
import { GENIRO_MCP_SERVER_KEY } from '../../adapter.types';
import {
  CURSOR_MCP_ENABLE_SUBCOMMAND,
  CURSOR_MCP_ENABLE_TIMEOUT_MS,
} from '../cursor.const';
import type { EnableGeniroMcpOptions } from '../cursor.types';

/**
 * Best-effort `cursor-agent mcp enable geniro` in `cwd` — clears the hidden
 * approval gate headless cursor-agent applies to project MCP servers, for OUR
 * namespaced key only (never `--approve-mcps`, which would blanket-approve the
 * user's other servers). Always resolves: a failure here degrades to the
 * probe/run verdict, it is never fatal by itself. Shared by the trust probe
 * and the per-turn merge so both exercise the identical approval surface.
 */
export function enableGeniroMcpServer(
  cwd: string,
  options: EnableGeniroMcpOptions = {},
): Promise<void> {
  const run = options.execFileFn ?? execFile;
  return new Promise((resolve) => {
    try {
      const child = run(
        resolveAgentBinary(AgentKind.CursorAgent),
        [...CURSOR_MCP_ENABLE_SUBCOMMAND, GENIRO_MCP_SERVER_KEY],
        {
          cwd,
          timeout: options.timeoutMs ?? CURSOR_MCP_ENABLE_TIMEOUT_MS,
          encoding: 'utf8',
          env: buildChildEnv(),
        },
        () => resolve(),
      );
      options.onSpawn?.(child);
    } catch {
      resolve();
    }
  });
}
