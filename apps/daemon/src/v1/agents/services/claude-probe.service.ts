import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { Injectable, Logger } from '@nestjs/common';

import { environment } from '../../../environments';
import { ClaudeAdapter } from '../adapters/claude/claude.adapter';
import type {
  ClaudeModeProbeStatus,
  ClaudeModesCapability,
} from '../chat.types';
import { resolveAgentVersion } from '../utils/agent-version';
import { childProcessHandle } from '../utils/child-handle';
import { ProcessRegistry } from './process-registry';

/** The permission modes whose headless support is empirical, not assumed. */
type ProbedMode = 'acceptEdits' | 'plan';

const PROBE_PROMPT = 'Reply with exactly: ok';

/** A hung probe turn must not wedge the capability read forever. */
const PROBE_TURN_TIMEOUT_MS = 30_000;

/**
 * An argv-level rejection of `--permission-mode <value>` is the one GENUINE
 * fail — every other pre-session exit (auth, network, missing binary) is an
 * environmental `unknown` that must not be disk-cached against this version.
 */
function isModeRejection(message: string): boolean {
  return (
    /permission-mode/i.test(message) &&
    /invalid|allowed choices|unknown/i.test(message)
  );
}

export interface ClaudeProbeOptions {
  /** Temp workspaces root (test seam); default `<userData>/claude-probe`. */
  probeRootDir?: string;
  /** Verdict cache file (test seam); default `<userData>/claude-probe.json`. */
  cachePath?: string;
  turnTimeoutMs?: number;
  /** Replacement version resolver for tests. */
  resolveVersionFn?: typeof resolveAgentVersion;
}

interface ModeProbeResult {
  status: ClaudeModeProbeStatus;
  reason: string | null;
  /** Only a real pass or a real argv rejection may be disk-cached. */
  genuine: boolean;
}

/**
 * The claude permission-mode probe (parity milestone 1). `acceptEdits` and
 * `plan` exist in current claude CLIs, but the installed binary is the only
 * honest source of truth — an older CLI rejects the `--permission-mode` value
 * on argv before any turn runs. The probe spawns one real headless turn per
 * mode in a daemon-owned temp cwd and watches for the CLI's own session/init
 * line: init observed = the mode was accepted (the turn is cancelled right
 * there — the rest is spend without information); an argv rejection before
 * init = a genuine fail; anything else (timeout, spawn error, auth failure)
 * = `unknown`, kept memory-only so an environmental hiccup can never
 * disk-poison the per-version cache. Verdicts are cached keyed by
 * `claude --version`, mirroring the cursor MCP-trust probe.
 */
@Injectable()
export class ClaudeProbeService {
  private readonly logger = new Logger(ClaudeProbeService.name);
  private readonly probeRootDir: string;
  private readonly cachePath: string;
  private readonly turnTimeoutMs: number;
  private readonly resolveVersionFn: typeof resolveAgentVersion;

  /** Latest settled verdict this launch (both modes pass/fail — never unknown). */
  private verdict: ClaudeModesCapability | null = null;
  private inFlight: Promise<ClaudeModesCapability> | null = null;

  constructor(
    private readonly claudeAdapter: ClaudeAdapter,
    private readonly processes: ProcessRegistry,
    options: ClaudeProbeOptions = {},
  ) {
    this.probeRootDir =
      options.probeRootDir ?? join(environment.userDataDir, 'claude-probe');
    this.cachePath =
      options.cachePath ?? join(environment.userDataDir, 'claude-probe.json');
    this.turnTimeoutMs = options.turnTimeoutMs ?? PROBE_TURN_TIMEOUT_MS;
    this.resolveVersionFn = options.resolveVersionFn ?? resolveAgentVersion;
  }

  /** The current verdict without probing — all-`unknown` until a probe ran. */
  capability(): ClaudeModesCapability {
    return (
      this.verdict ?? {
        acceptEdits: 'unknown',
        plan: 'unknown',
        version: null,
        probedAt: null,
        reason: 'claude permission modes have not been probed yet',
      }
    );
  }

  /**
   * The read behind GET /v1/capabilities. An unprobed verdict pre-warms the
   * probe in the background (fire-and-forget), so by the time the user sends
   * an acceptEdits/plan turn the verdict is usually settled.
   */
  wireCapability(): ClaudeModesCapability {
    const current = this.capability();
    if (current.acceptEdits === 'unknown' || current.plan === 'unknown') {
      void this.ensureVerdict();
    }
    return current;
  }

  /**
   * The cached verdict, probing at most once concurrently. Re-checks the
   * installed binary version on every call (cheap `--version`), so a claude
   * upgrade re-probes without a daemon restart.
   */
  async ensureVerdict(): Promise<ClaudeModesCapability> {
    if (this.inFlight) {
      return this.inFlight;
    }
    this.inFlight = this.resolveVerdict().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async resolveVerdict(): Promise<ClaudeModesCapability> {
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
    const acceptEdits = await this.probeMode('acceptEdits');
    const plan = await this.probeMode('plan');
    const reason = acceptEdits.reason ?? plan.reason;
    const capability: ClaudeModesCapability = {
      acceptEdits: acceptEdits.status,
      plan: plan.status,
      version,
      probedAt: Date.now(),
      reason,
    };
    if (acceptEdits.genuine && plan.genuine) {
      // Only a fully-settled verdict is remembered (and disk-cached): an
      // environmental `unknown` must retry on the next read, not stick.
      this.verdict = capability;
      if (version !== null) {
        this.writeCache(capability);
      }
    }
    return capability;
  }

  private async probeMode(mode: ProbedMode): Promise<ModeProbeResult> {
    const cwd = join(this.probeRootDir, `${mode}-${randomUUID()}`);
    let lastError: string | null = null;
    let sawInit = false;
    let timedOut = false;
    try {
      mkdirSync(cwd, { recursive: true });
      let resolveInit!: () => void;
      const initSeen = new Promise<void>((resolve) => {
        resolveInit = resolve;
      });
      const handle = this.claudeAdapter.start(
        { prompt: PROBE_PROMPT, cwd, approvalMode: mode },
        (event) => {
          if (event.type === 'session' && !sawInit) {
            // The CLI reached its session/init line — the argv (including
            // the probed --permission-mode value) was accepted.
            sawInit = true;
            resolveInit();
          }
          if (event.type === 'error') {
            lastError = event.message;
          }
        },
      );
      this.processes.register(`claude-probe:${mode}:${randomUUID()}`, handle);
      const timer = setTimeout(() => {
        timedOut = true;
        handle.cancel();
      }, this.turnTimeoutMs);
      timer.unref?.();
      const initWon = await Promise.race([
        initSeen.then(() => true),
        handle.done.then(() => false),
      ]);
      if (initWon) {
        // Proof is in — the rest of the turn is spend without information.
        handle.cancel();
      }
      await handle.done;
      clearTimeout(timer);
    } catch (err) {
      return {
        status: 'unknown',
        reason: `claude ${mode} probe failed to start: ${err instanceof Error ? err.message : String(err)}`,
        genuine: false,
      };
    } finally {
      try {
        rmSync(cwd, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup only: a straggler of the just-cancelled probe
        // process group writing into `cwd` can make rmSync throw
        // (EBUSY/ENOTEMPTY — `force` suppresses only ENOENT). That must never
        // reject the verdict; the temp dir is reaped on the next probe/boot.
      }
    }
    if (sawInit) {
      this.logger.log(`claude --permission-mode ${mode} probe passed`);
      return { status: 'pass', reason: null, genuine: true };
    }
    if (timedOut) {
      return {
        status: 'unknown',
        reason: `claude ${mode} probe timed out after ${Math.round(this.turnTimeoutMs / 1000)}s`,
        genuine: false,
      };
    }
    if (lastError !== null && isModeRejection(lastError)) {
      this.logger.warn(
        `claude rejected --permission-mode ${mode}: ${String(lastError)}`,
      );
      return {
        status: 'fail',
        reason: `installed claude does not support --permission-mode ${mode}`,
        genuine: true,
      };
    }
    return {
      status: 'unknown',
      reason:
        lastError ?? `claude exited before its session line (${mode} probe)`,
      genuine: false,
    };
  }

  private async readVersion(): Promise<string | null> {
    return this.resolveVersionFn('claude', {
      onSpawn: (child) =>
        this.processes.register(
          `claude-probe:version:${randomUUID()}`,
          childProcessHandle(child),
        ),
    });
  }

  private readCache(): ClaudeModesCapability | null {
    try {
      const parsed = JSON.parse(
        readFileSync(this.cachePath, 'utf8'),
      ) as Partial<ClaudeModesCapability>;
      const settled = (s: unknown): s is ClaudeModeProbeStatus =>
        s === 'pass' || s === 'fail';
      if (
        settled(parsed.acceptEdits) &&
        settled(parsed.plan) &&
        typeof parsed.version === 'string'
      ) {
        return {
          acceptEdits: parsed.acceptEdits,
          plan: parsed.plan,
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

  private writeCache(capability: ClaudeModesCapability): void {
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
