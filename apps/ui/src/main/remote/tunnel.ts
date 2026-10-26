import { type ChildProcess, spawn } from 'node:child_process';

import type { RemoteTunnelState, TunnelProviderId } from '../../shared/remote';
import { resolveBinary } from '../resolve-binary';
import {
  TUNNEL_ANSWER_GAP_MS,
  TUNNEL_EXPIRED_AFTER_MS,
  TUNNEL_EXPIRY_CONFIRM_MS,
  TUNNEL_LIVENESS_POLL_MS,
  TUNNEL_OUTPUT_KEPT,
  TUNNEL_READY_PROBE_TIMEOUT_MS,
  TUNNEL_URL_WAIT_MS,
} from './remote.types';

/**
 * One tunnel client geniro knows how to drive.
 *
 * Everything CLI-specific about a provider is a field here and nothing about
 * one is branched on elsewhere in this directory — the same rule the daemon's
 * agent adapters follow, and for the same reason: a third provider should be
 * a row in {@link PROVIDERS} rather than an `if` in the supervisor.
 */
interface TunnelProvider {
  id: TunnelProviderId;
  /** What the user is told is running. */
  label: string;
  /** The binary name, resolved through `resolveBinary` — never spawned bare. */
  bin: string;
  args(port: number): string[];
  /**
   * Finds the public URL in the client's own output. Group 1 when the pattern
   * has one (ngrok's URL is a JSON field), else the whole match.
   */
  url: RegExp;
  /**
   * The client's own readiness endpoint, which answers 200 only while the
   * client holds a connection to the provider: `address` captures (group 1)
   * its `127.0.0.1:port` in the client's output — loopback only, since the
   * public address is never probed — and `path` is where it answers. A
   * provider without one is watched for its exit alone.
   */
  readiness?: { address: RegExp; path: string };
}

/**
 * In PREFERENCE order, and the order is the whole of the choice.
 *
 * Measured on a machine carrying both: cloudflared's quick tunnel answered
 * with a public URL in about five seconds having never been configured — no
 * account, no login, an empty `~/.cloudflared` — while ngrok answered in about
 * one second but only because an authtoken was already on disk, which a fresh
 * user of geniro has no reason to have. cloudflared also serves the address
 * without ngrok's browser interstitial, and does not put the user's public IP
 * in the hostname the way `9b36-37-99-2-231.ngrok-free.app` does.
 *
 * ngrok stays as the fallback because it is what people already have.
 */
const PROVIDERS: readonly TunnelProvider[] = [
  {
    id: 'cloudflared',
    label: 'cloudflared',
    bin: 'cloudflared',
    // `--no-autoupdate`: the client otherwise replaces its own binary and
    // restarts mid-session, which drops the tunnel under a URL already on the
    // user's screen. `--metrics 127.0.0.1:0`: the default listens on
    // `localhost` in a port range every cloudflared on the machine shares, so
    // the readiness endpoint is pinned to loopback and its port read back
    // from the client's own log line.
    args: (port) => [
      'tunnel',
      '--no-autoupdate',
      '--metrics',
      '127.0.0.1:0',
      '--url',
      `http://127.0.0.1:${port}`,
    ],
    url: /(https:\/\/[a-z0-9-]+\.trycloudflare\.com)/i,
    readiness: {
      address: /Starting metrics server on (127\.0\.0\.1:\d+)\/metrics/,
      path: '/ready',
    },
  },
  {
    id: 'ngrok',
    label: 'ngrok',
    bin: 'ngrok',
    args: (port) => [
      'http',
      String(port),
      '--log',
      'stdout',
      '--log-format',
      'json',
    ],
    url: /"url":"(https:\/\/[^"]+)"/i,
  },
];

const OFF: RemoteTunnelState = {
  status: 'off',
  provider: null,
  url: null,
  error: null,
};

/**
 * The `*.suffix` the host guard is widened by while a tunnel serves this URL.
 *
 * DERIVED from the address the client actually handed back rather than stored
 * per provider, because a provider's suffix is not one value: a paid ngrok
 * account is served from `*.ngrok.app` or a domain of the user's own, and a
 * table of literals would silently fail to admit exactly the users who paid.
 * Dropping the leading label is also what makes the mask survive the rotation
 * this whole wildcard exists for.
 *
 * A URL whose host has too few labels answers null, and the guard refuses a
 * one-label suffix besides — two independent refusals of the same widening,
 * which is deliberate: this one keeps a bad mask from ever being offered, and
 * `wildcardAdmits` keeps one from being honoured if it is.
 */
export function tunnelHostPattern(url: string): string | null {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  const labels = host.split('.');
  if (labels.length < 3) {
    return null;
  }
  return `*.${labels.slice(1).join('.')}`;
}

export interface RemoteTunnelOptions {
  /** Test seams — a spec drives a fake client rather than opening a tunnel. */
  spawnProcess?: typeof spawn;
  resolveBin?: (name: string) => string | null;
  /** Test seam for the URL wait; defaults to {@link TUNNEL_URL_WAIT_MS}. */
  urlWaitMs?: number;
  /** Test seam for the liveness poll; defaults to {@link TUNNEL_LIVENESS_POLL_MS}. */
  livenessPollMs?: number;
  /** Test seam for the readiness request; defaults to {@link probeReady}. */
  probeReady?: (url: string) => Promise<boolean>;
}

/** End a client; resolves once it has exited or been SIGKILLed. Never throws. */
async function reap(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  await new Promise<void>((resolve) => {
    const done = (): void => {
      clearTimeout(escalate);
      resolve();
    };
    // SIGTERM lets the client close its connection to the provider; the
    // escalation is what stops a wedged one from holding up a quit.
    const escalate = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 2_000);
    escalate.unref?.();
    child.once('exit', done);
    child.kill('SIGTERM');
  });
}

/**
 * Whether the client's readiness endpoint at `url` answers 200. Never throws:
 * an unreachable endpoint is a client without a connection, not an error.
 */
export async function probeReady(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(TUNNEL_READY_PROBE_TIMEOUT_MS),
    });
    const ok = res.ok;
    // Unread, the body would hold the socket until garbage collection; the
    // cleanup failing (the timeout firing meanwhile) leaves the answer alone.
    await res.body?.cancel().catch(() => undefined);
    return ok;
  } catch {
    return false;
  }
}

/**
 * The child process that gives the LAN gateway an INTERNET address.
 *
 * geniro runs no relay and hosts nothing: it starts a tunnel client the USER
 * has installed, on the user's own machine, pointed at the loopback side of a
 * listener that is already running, and reads the address that client prints.
 * Nothing about the daemon changes — it still binds `127.0.0.1` and is still
 * reachable only through the gateway, under the same Host guard, the same
 * pairing gate and the same injected credential.
 *
 * It is opened by a PRESS and never on geniro's own initiative, and it is torn
 * down with the app: the process is this one's child, so a quit takes it, and
 * `stop()` is called from the gateway's own teardown rather than left to the
 * kernel.
 */
export class RemoteTunnel {
  private child: ChildProcess | null = null;
  private current: RemoteTunnelState = OFF;
  /** An in-flight `start()`, so two presses cannot open two clients. */
  private starting: Promise<RemoteTunnelState> | null = null;
  private readonly spawnProcess: typeof spawn;
  private readonly resolveBin: (name: string) => string | null;
  private readonly urlWaitMs: number;
  private readonly livenessPollMs: number;
  private readonly probeReadyFn: (url: string) => Promise<boolean>;
  private liveness: ReturnType<typeof setInterval> | null = null;

  constructor(options: RemoteTunnelOptions = {}) {
    this.spawnProcess = options.spawnProcess ?? spawn;
    this.resolveBin = options.resolveBin ?? ((name) => resolveBinary(name));
    this.urlWaitMs = options.urlWaitMs ?? TUNNEL_URL_WAIT_MS;
    this.livenessPollMs = options.livenessPollMs ?? TUNNEL_LIVENESS_POLL_MS;
    this.probeReadyFn = options.probeReady ?? probeReady;
  }

  state(): RemoteTunnelState {
    return this.current;
  }

  /**
   * The host pattern the gateway must admit while this tunnel is open, or null.
   *
   * Gated on `open` rather than answered from the last URL seen, so a tunnel
   * that has been closed stops widening the guard at the moment it closes —
   * a mask left standing would admit a provider's whole zone for the rest of
   * the launch, for no live tunnel at all.
   */
  allowedHostPattern(): string | null {
    if (this.current.status !== 'open' || !this.current.url) {
      return null;
    }
    return tunnelHostPattern(this.current.url);
  }

  async start(port: number): Promise<RemoteTunnelState> {
    if (this.starting) {
      return this.starting;
    }
    if (this.current.status === 'open') {
      return this.current;
    }
    this.starting = this.run(port).finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  /**
   * Kill the client. Idempotent, and never throws: this is called from app
   * teardown, where a failure to reap a child must not stop the quit.
   */
  async stop(): Promise<RemoteTunnelState> {
    const child = this.child;
    this.child = null;
    this.current = OFF;
    this.stopLiveness();
    if (child) {
      await reap(child);
    }
    return this.current;
  }

  private async run(port: number): Promise<RemoteTunnelState> {
    const provider = this.pickProvider();
    if (!provider) {
      this.current = {
        status: 'error',
        provider: null,
        url: null,
        error:
          'No tunnel client found. Install one with `brew install cloudflared` (no account needed) or `brew install ngrok`.',
      };
      return this.current;
    }

    const { provider: chosen, bin } = provider;
    this.current = {
      status: 'starting',
      provider: chosen.id,
      url: null,
      error: null,
    };

    const child = this.spawnProcess(bin, chosen.args(port), {
      // The client talks to the provider and to loopback; it needs nothing
      // from this app's environment, and `GENIRO_`-prefixed config is the
      // daemon's business rather than a third party's.
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;

    return new Promise<RemoteTunnelState>((resolve) => {
      // The tail of what the client said, so a failure is reported in its own
      // words rather than as a bare exit code the user can do nothing with.
      const output: string[] = [];
      let settled = false;
      let watching = false;
      const finish = (next: RemoteTunnelState): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        this.current = next;
        resolve(next);
      };

      const readLine = (line: string): void => {
        const address = chosen.readiness?.address.exec(line)?.[1];
        if (address && chosen.readiness && !watching) {
          watching = true;
          this.watchLiveness(
            child,
            chosen,
            `http://${address}${chosen.readiness.path}`,
          );
        }
        const found = chosen.url.exec(line);
        const url = found?.[1] ?? found?.[0];
        if (!url) {
          return;
        }
        // Written on EVERY match rather than only the first, because ngrok
        // was measured handing out a new URL on a mid-session reconnect: the
        // mask still admits it, but a screen showing the old address would
        // send the user to a name nothing answers on.
        this.current = {
          status: 'open',
          provider: chosen.id,
          url,
          error: null,
        };
        finish(this.current);
      };

      // One reader per stream. A pipe read can end mid-line, so lines are
      // matched whole: a URL or readiness line split across two reads would
      // otherwise go unseen.
      const readStream = (): ((chunk: Buffer) => void) => {
        let partial = '';
        return (chunk) => {
          // Output a stopped or replaced client still had buffered must not
          // reopen the state or start a watcher for it.
          if (this.child !== child) {
            return;
          }
          const text = chunk.toString();
          output.push(text);
          if (output.length > TUNNEL_OUTPUT_KEPT) {
            output.shift();
          }
          const lines = (partial + text).split('\n');
          partial = lines.pop() ?? '';
          for (const line of lines) {
            readLine(line);
          }
        };
      };
      child.stdout?.on('data', readStream());
      child.stderr?.on('data', readStream());

      // Settles a start that is still waiting, with whatever state `end`
      // left: an error, or `off` when `stop()` got there first.
      const fail = (reason: string, reapClient = false): void => {
        this.end(child, chosen, reason, reapClient);
        finish(this.current);
      };

      child.once('error', (err: Error) => {
        fail(`${chosen.label} could not be started: ${err.message}`);
      });
      // Reached after an address was handed out too: the client died, so the
      // address it served is dead with it.
      child.once('exit', (code, signal) => {
        fail(
          `${chosen.label} stopped (${signal ?? `exit ${String(code)}`}): ${
            output.join('').trim().split('\n').slice(-3).join(' ') ||
            'it printed nothing'
          }`,
        );
      });

      const timer = setTimeout(() => {
        fail(
          `${chosen.label} did not report an address within ${String(
            Math.round(this.urlWaitMs / 1000),
          )}s.`,
          true,
        );
      }, this.urlWaitMs);
      timer.unref?.();
    });
  }

  /**
   * The one way a tunnel ends on its own: release `child`, stop watching it
   * and report `error`. A no-op once `child` is no longer the current client —
   * `stop()` lets go of the child before reaping it, so its own exit, a late
   * probe or late output can never overwrite the state that came after.
   */
  private end(
    child: ChildProcess,
    provider: TunnelProvider,
    error: string,
    reapClient: boolean,
  ): void {
    if (this.child !== child) {
      return;
    }
    this.child = null;
    this.stopLiveness();
    this.current = { status: 'error', provider: provider.id, url: null, error };
    if (reapClient) {
      void reap(child);
    }
  }

  /**
   * Reports the address as expired, and reaps the client, once the client has
   * held no connection for {@link TUNNEL_EXPIRED_AFTER_MS}. The client never
   * says so itself: cloudflared retries a deleted quick tunnel forever.
   *
   * Measured on the wall clock rather than counted in polls, because the case
   * this exists for is a Mac asleep overnight, when no timer runs. For a few
   * seconds after wake the client still reports the connection it held before
   * sleeping, so a connection counts only when two answers in a row, within
   * {@link TUNNEL_ANSWER_GAP_MS} of each other, report it.
   */
  private watchLiveness(
    child: ChildProcess,
    provider: TunnelProvider,
    readinessUrl: string,
  ): void {
    this.stopLiveness();
    let connectedAt = Date.now();
    let failingSince = Date.now();
    let last: { at: number; ready: boolean } | null = null;
    let probing = false;
    const timer = setInterval(() => {
      if (probing) {
        return;
      }
      probing = true;
      void this.probeReadyFn(readinessUrl)
        .catch(() => false)
        .then((ready) => {
          probing = false;
          // A probe answered after the client was stopped or replaced, or
          // before it reported an address, decides nothing.
          if (this.child !== child || this.current.status !== 'open') {
            return;
          }
          const now = Date.now();
          const previous =
            last && now - last.at <= TUNNEL_ANSWER_GAP_MS ? last : null;
          last = { at: now, ready };
          if (ready) {
            if (previous?.ready) {
              connectedAt = now;
            }
            return;
          }
          if (!previous || previous.ready) {
            failingSince = now;
          }
          if (
            now - failingSince < TUNNEL_EXPIRY_CONFIRM_MS ||
            now - connectedAt < TUNNEL_EXPIRED_AFTER_MS
          ) {
            return;
          }
          this.end(
            child,
            provider,
            `The public address expired: ${provider.label} had no connection for over ${String(
              Math.round(TUNNEL_EXPIRED_AFTER_MS / 60_000),
            )} minutes (this Mac slept or went offline). Get a new address.`,
            true,
          );
        });
    }, this.livenessPollMs);
    timer.unref?.();
    this.liveness = timer;
  }

  private stopLiveness(): void {
    if (this.liveness) {
      clearInterval(this.liveness);
      this.liveness = null;
    }
  }

  private pickProvider(): { provider: TunnelProvider; bin: string } | null {
    for (const provider of PROVIDERS) {
      const bin = this.resolveBin(provider.bin);
      if (bin) {
        return { provider, bin };
      }
    }
    return null;
  }
}
