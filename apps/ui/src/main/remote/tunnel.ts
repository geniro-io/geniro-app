import { type ChildProcess, spawn } from 'node:child_process';

import type { RemoteTunnelState, TunnelProviderId } from '../../shared/remote';
import { resolveBinary } from '../resolve-binary';
import { TUNNEL_OUTPUT_KEPT, TUNNEL_URL_WAIT_MS } from './remote.types';

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
    // user's screen.
    args: (port) => [
      'tunnel',
      '--no-autoupdate',
      '--url',
      `http://127.0.0.1:${port}`,
    ],
    url: /(https:\/\/[a-z0-9-]+\.trycloudflare\.com)/i,
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

  constructor(options: RemoteTunnelOptions = {}) {
    this.spawnProcess = options.spawnProcess ?? spawn;
    this.resolveBin = options.resolveBin ?? ((name) => resolveBinary(name));
    this.urlWaitMs = options.urlWaitMs ?? TUNNEL_URL_WAIT_MS;
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
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      return this.current;
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
      const finish = (next: RemoteTunnelState): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        this.current = next;
        resolve(next);
      };

      const read = (chunk: Buffer): void => {
        const text = chunk.toString();
        output.push(text);
        if (output.length > TUNNEL_OUTPUT_KEPT) {
          output.shift();
        }
        const found = chosen.url.exec(text);
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

      child.stdout?.on('data', read);
      child.stderr?.on('data', read);

      const fail = (reason: string): void => {
        this.child = null;
        finish({
          status: 'error',
          provider: chosen.id,
          url: null,
          error: reason,
        });
      };

      child.once('error', (err: Error) => {
        fail(`${chosen.label} could not be started: ${err.message}`);
      });
      child.once('exit', (code, signal) => {
        // Reached after a successful start too, when the client dies later —
        // `finish` has already settled by then, so this only ever reports a
        // start that never produced an address.
        fail(
          `${chosen.label} stopped (${signal ?? `exit ${String(code)}`}): ${
            output.join('').trim().split('\n').slice(-3).join(' ') ||
            'it printed nothing'
          }`,
        );
      });

      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        fail(
          `${chosen.label} did not report an address within ${String(
            Math.round(this.urlWaitMs / 1000),
          )}s.`,
        );
      }, this.urlWaitMs);
      timer.unref?.();
    });
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
