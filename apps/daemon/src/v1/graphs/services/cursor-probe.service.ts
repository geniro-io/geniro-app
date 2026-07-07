import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { Injectable, Logger } from '@nestjs/common';

import { CallTokenRegistry } from '../../../auth/call-token.registry';
import { mintToken } from '../../../auth/mint-token';
import type { RuntimeInfo } from '../../../auth/runtime';
import { environment } from '../../../environments';
import { CursorAdapter } from '../../agents/adapters/cursor/cursor.adapter';
import { ProcessRegistry } from '../../agents/services/process-registry';
import { resolveAgentVersion } from '../../agents/utils/agent-version';
import { childProcessHandle } from '../../agents/utils/child-handle';
import { enableGeniroMcpServer } from '../../agents/utils/cursor-mcp-enable';
import { buildCursorMcpServerEntry } from '../../agents/utils/cursor-mcp-entry';
import { mergeGeniroEntry } from '../../agents/utils/cursor-mcp-file';
import type { CapabilitiesWire, CursorCallsCapability } from '../graphs.types';

/** The probe's synthetic node id on the `/v1/mcp/<probeId>/<nodeId>` route. */
const PROBE_NODE_ID = 'probe';

/** Probe run ids are self-describing so a transcript row can never carry one. */
const PROBE_RUN_PREFIX = 'probe-';

const PROBE_PROMPT =
  'An MCP server named "geniro" provides one tool called "echo". Call the ' +
  'echo tool exactly once with the text "geniro-probe" and then reply with ' +
  'its result. If no such tool is available, reply exactly: no tool.';

/** A hung probe turn must not wedge run-start forever. */
const PROBE_TURN_TIMEOUT_MS = 90_000;

export interface CursorProbeOptions {
  /** Temp workspaces root (test seam); default `<userData>/cursor-probe`. */
  probeRootDir?: string;
  /** Verdict cache file (test seam); default `<userData>/cursor-probe.json`. */
  cachePath?: string;
  turnTimeoutMs?: number;
  /** Replacement execFile for tests (the `mcp enable` child). */
  execFileFn?: typeof execFile;
  /** Replacement version resolver for tests. */
  resolveVersionFn?: typeof resolveAgentVersion;
}

interface ActiveProbe {
  echoCalled: boolean;
  resolveEcho: () => void;
}

/**
 * The one-time cursor-agent MCP-trust probe (M3 step-1). Headless cursor-agent
 * has no `--mcp-config` flag and SILENTLY drops project MCP servers it has not
 * approved, so the only honest capability signal is empirical: spawn one real
 * `cursor-agent -p` turn in a daemon-owned temp workspace whose
 * `.cursor/mcp.json` points at this daemon's MCP route, and see whether the
 * echo tool served there is actually CALLED (server-side proof — never parsed
 * from model output). The verdict is cached keyed by the installed binary's
 * `--version` line: a binary that can't report a version gets a memory-only
 * verdict for this launch ("unknown" must never be disk-poisoned).
 *
 * The temp workspace uses the SAME server-entry shape and the same targeted
 * approval surfaces (`autoApprove` in the entry + `cursor-agent mcp enable
 * geniro`) that real caller turns get from the merge machinery, so a `pass`
 * here transfers to real runs.
 */
@Injectable()
export class CursorProbeService {
  private readonly logger = new Logger(CursorProbeService.name);
  private readonly probeRootDir: string;
  private readonly cachePath: string;
  private readonly turnTimeoutMs: number;
  private readonly execFileFn: typeof execFile;
  private readonly resolveVersionFn: typeof resolveAgentVersion;

  /** Latest pass/fail verdict this launch (never `unknown`). */
  private verdict: CursorCallsCapability | null = null;
  private inFlight: Promise<CursorCallsCapability> | null = null;
  private readonly activeProbes = new Map<string, ActiveProbe>();

  constructor(
    private readonly cursorAdapter: CursorAdapter,
    private readonly callTokens: CallTokenRegistry,
    private readonly processes: ProcessRegistry,
    private readonly runtime: RuntimeInfo,
    options: CursorProbeOptions = {},
  ) {
    this.probeRootDir =
      options.probeRootDir ?? join(environment.userDataDir, 'cursor-probe');
    this.cachePath =
      options.cachePath ?? join(environment.userDataDir, 'cursor-probe.json');
    this.turnTimeoutMs = options.turnTimeoutMs ?? PROBE_TURN_TIMEOUT_MS;
    this.execFileFn = options.execFileFn ?? execFile;
    this.resolveVersionFn = options.resolveVersionFn ?? resolveAgentVersion;
  }

  /** The current verdict without probing — `unknown` until a probe ran. */
  capability(): CursorCallsCapability {
    return (
      this.verdict ?? {
        status: 'unknown',
        version: null,
        probedAt: null,
        reason: 'cursor-agent MCP support has not been probed yet',
      }
    );
  }

  /**
   * The read behind GET /v1/capabilities. An `unknown` verdict pre-warms the
   * probe in the background (fire-and-forget), so the builder's next poll —
   * and the eventual run start — find a settled verdict instead of waiting
   * the whole probe turn out.
   */
  capabilitiesWire(): CapabilitiesWire {
    const current = this.capability();
    if (current.status === 'unknown' && this.runtime.port !== null) {
      void this.ensureVerdict();
    }
    return { cursorCalls: current };
  }

  /** True while `runId` is a live probe — the MCP host serves echo for it. */
  isProbeRun(runId: string): boolean {
    return this.activeProbes.has(runId);
  }

  /** The MCP host observed a real tools/call on the probe's echo tool. */
  noteEchoCall(runId: string): void {
    const probe = this.activeProbes.get(runId);
    if (probe && !probe.echoCalled) {
      probe.echoCalled = true;
      probe.resolveEcho();
    }
  }

  /**
   * The cached verdict, probing at most once concurrently. Re-checks the
   * installed binary version on every call (cheap `--version`), so a cursor
   * upgrade re-probes without a daemon restart.
   */
  async ensureVerdict(): Promise<CursorCallsCapability> {
    if (this.inFlight) {
      return this.inFlight;
    }
    this.inFlight = this.resolveVerdict().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async resolveVerdict(): Promise<CursorCallsCapability> {
    const version = await this.readVersion();
    if (this.verdict && this.verdict.version === version) {
      return this.verdict;
    }
    if (version !== null) {
      const cached = this.readCache();
      if (cached && cached.version === version) {
        this.verdict = cached;
        return cached;
      }
    }
    const fresh = await this.runProbe(version);
    if (fresh.capability.status === 'unknown') {
      // Not a verdict — the environment wasn't ready (e.g. port not bound).
      return fresh.capability;
    }
    this.verdict = fresh.capability;
    // Only a GENUINE verdict is disk-cached. An environmental failure (the
    // turn never ran, or the 90s cap killed it) would otherwise poison the
    // per-version cache and disable cursor calls until a cursor upgrade.
    if (fresh.cacheable && version !== null) {
      this.writeCache(fresh.capability);
    }
    return fresh.capability;
  }

  private async runProbe(
    version: string | null,
  ): Promise<{ capability: CursorCallsCapability; cacheable: boolean }> {
    const port = this.runtime.port;
    if (port === null) {
      return {
        capability: {
          status: 'unknown',
          version,
          probedAt: null,
          reason: 'daemon port not bound yet',
        },
        cacheable: false,
      };
    }
    const probeId = `${PROBE_RUN_PREFIX}${randomUUID()}`;
    const cwd = join(this.probeRootDir, probeId);
    const token = mintToken();
    this.callTokens.issue(probeId, PROBE_NODE_ID, token);

    const probeEntry: ActiveProbe = {
      echoCalled: false,
      resolveEcho: () => {},
    };
    this.activeProbes.set(probeId, probeEntry);
    let timedOut = false;

    /**
     * One probe turn. The echo waiter is per attempt (the resolver is swapped
     * on the shared ActiveProbe entry), so a retry gets a fresh race.
     * Returns the turn's last error line, or null.
     */
    const attempt = async (trustWorkspace: boolean): Promise<string | null> => {
      let lastError: string | null = null;
      let resolveEcho!: () => void;
      const echoCalled = new Promise<void>((resolve) => {
        resolveEcho = resolve;
      });
      probeEntry.resolveEcho = resolveEcho;
      const handle = this.cursorAdapter.start(
        {
          prompt: PROBE_PROMPT,
          cwd,
          approvalMode: 'auto',
          ...(trustWorkspace ? { trustWorkspace: true } : {}),
        },
        (event) => {
          if (event.type === 'error') {
            lastError = event.message;
          }
        },
      );
      this.processes.register(`cursor-probe:${probeId}`, handle);
      const timer = setTimeout(() => {
        timedOut = true;
        handle.cancel();
      }, this.turnTimeoutMs);
      timer.unref?.();
      const echoWon = await Promise.race([
        echoCalled.then(() => true),
        handle.done.then(() => false),
      ]);
      if (echoWon) {
        // Proof is in — the rest of the turn is spend without information.
        handle.cancel();
      }
      await handle.done;
      clearTimeout(timer);
      return lastError;
    };

    try {
      // The SAME file write real turns get — the probe cwd is fresh, so this
      // is deterministically the create branch (one owner for the file shape).
      const merged = mergeGeniroEntry(
        cwd,
        buildCursorMcpServerEntry(
          {
            url: `http://127.0.0.1:${port}/v1/mcp/${probeId}/${PROBE_NODE_ID}`,
            token,
          },
          ['echo'],
        ),
      );
      if (!merged.ok) {
        throw new Error(merged.reason);
      }
      await enableGeniroMcpServer(cwd, {
        execFileFn: this.execFileFn,
        onSpawn: (child) =>
          this.processes.register(
            `cursor-probe:enable:${probeId}`,
            childProcessHandle(child),
          ),
      });

      let lastError = await attempt(true);
      if (
        !probeEntry.echoCalled &&
        lastError?.includes("unknown option '--trust'")
      ) {
        // Older cursor-agent without --trust: the FLAG killed the turn, not a
        // missing MCP trust — retry bare so the verdict measures the right
        // thing (real caller turns never pass --trust anyway).
        lastError = await attempt(false);
      }

      if (probeEntry.echoCalled) {
        this.logger.log(`cursor-agent MCP probe passed (version ${version})`);
        return {
          capability: {
            status: 'pass',
            version,
            probedAt: Date.now(),
            reason: null,
          },
          cacheable: true,
        };
      }
      if (timedOut) {
        const reason = `probe turn timed out after ${Math.round(this.turnTimeoutMs / 1000)}s`;
        this.logger.warn(`cursor-agent MCP probe failed: ${reason}`);
        return {
          capability: { status: 'fail', version, probedAt: Date.now(), reason },
          cacheable: false,
        };
      }
      const reason =
        lastError ??
        'cursor-agent never called the probe tool — the installed version ' +
          'does not attach project .cursor/mcp.json servers headlessly';
      this.logger.warn(`cursor-agent MCP probe failed: ${reason}`);
      return {
        capability: { status: 'fail', version, probedAt: Date.now(), reason },
        cacheable: true,
      };
    } catch (err) {
      const reason = `probe turn failed to start: ${err instanceof Error ? err.message : String(err)}`;
      this.logger.warn(reason);
      return {
        capability: { status: 'fail', version, probedAt: Date.now(), reason },
        cacheable: false,
      };
    } finally {
      this.activeProbes.delete(probeId);
      this.callTokens.revokeRun(probeId);
      rmSync(cwd, { recursive: true, force: true });
    }
  }

  private async readVersion(): Promise<string | null> {
    return this.resolveVersionFn('cursor-agent', {
      onSpawn: (child) =>
        this.processes.register(
          `cursor-probe:version:${randomUUID()}`,
          childProcessHandle(child),
        ),
    });
  }

  private readCache(): CursorCallsCapability | null {
    try {
      const parsed = JSON.parse(
        readFileSync(this.cachePath, 'utf8'),
      ) as Partial<CursorCallsCapability>;
      if (
        (parsed.status === 'pass' || parsed.status === 'fail') &&
        typeof parsed.version === 'string'
      ) {
        return {
          status: parsed.status,
          version: parsed.version,
          probedAt:
            typeof parsed.probedAt === 'number' ? parsed.probedAt : null,
          reason: typeof parsed.reason === 'string' ? parsed.reason : null,
        };
      }
    } catch {
      // No cache yet, or an unreadable one — a fresh probe will rewrite it.
    }
    return null;
  }

  private writeCache(capability: CursorCallsCapability): void {
    try {
      mkdirSync(dirname(this.cachePath), { recursive: true });
      writeFileSync(this.cachePath, JSON.stringify(capability), {
        encoding: 'utf8',
        mode: 0o600,
      });
    } catch (err) {
      this.logger.warn(`could not persist probe verdict: ${String(err)}`);
    }
  }
}
