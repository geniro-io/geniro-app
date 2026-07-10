import { type ChildProcess, execFile } from 'node:child_process';

import { resolveAgentBinary } from './agent-binary';
import { buildChildEnv } from './child-env';
import { GENIRO_MCP_SERVER_KEY } from './cursor-mcp-entry';

/** `cursor-agent mcp enable` must never wedge a turn start — bound it. */
const ENABLE_TIMEOUT_MS = 10_000;

export interface EnableGeniroMcpOptions {
  timeoutMs?: number;
  /** Replacement execFile for tests. */
  execFileFn?: typeof execFile;
  /** Called with the spawned child so the caller can register it. */
  onSpawn?: (child: ChildProcess) => void;
}

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
        resolveAgentBinary('cursor-agent'),
        ['mcp', 'enable', GENIRO_MCP_SERVER_KEY],
        {
          cwd,
          timeout: options.timeoutMs ?? ENABLE_TIMEOUT_MS,
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
