import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  TUNNEL_EXPIRED_AFTER_MS,
  TUNNEL_EXPIRY_CONFIRM_MS,
} from './remote.types';
import { probeReady, RemoteTunnel, tunnelHostPattern } from './tunnel';

/**
 * A stand-in for a spawned tunnel client: two readable streams and the
 * `exit`/`error` events the supervisor listens for. Deliberately a real
 * `EventEmitter` with real streams rather than an object of spies, so the
 * supervisor's own listener wiring is what is exercised.
 */
function fakeChild(): EventEmitter & {
  stdout: Readable;
  stderr: Readable;
  kill: ReturnType<typeof vi.fn>;
  exitCode: number | null;
  signalCode: string | null;
} {
  const child = new EventEmitter() as ReturnType<typeof fakeChild>;
  child.stdout = new Readable({ read() {} });
  child.stderr = new Readable({ read() {} });
  child.exitCode = null;
  child.signalCode = null;
  child.kill = vi.fn(() => {
    // A real SIGTERM ends the process; without this the supervisor's own
    // escalation timer would be the only thing resolving `stop()`.
    queueMicrotask(() => child.emit('exit', null, 'SIGTERM'));
    return true;
  });
  return child;
}

function harness(options: { bins?: string[] } = {}) {
  const child = fakeChild();
  const installed = new Set(options.bins ?? ['cloudflared', 'ngrok']);
  const spawnProcess = vi.fn(() => child);
  const tunnel = new RemoteTunnel({
    spawnProcess: spawnProcess as never,
    resolveBin: (name) =>
      installed.has(name) ? `/opt/homebrew/bin/${name}` : null,
    urlWaitMs: 50,
  });
  return { tunnel, child, spawnProcess };
}

describe('tunnelHostPattern', () => {
  it('drops the leading label, which is the part that rotates', () => {
    expect(
      tunnelHostPattern('https://keyword-portsmouth.trycloudflare.com'),
    ).toBe('*.trycloudflare.com');
    expect(tunnelHostPattern('https://9b36-37-99-2-231.ngrok-free.app')).toBe(
      '*.ngrok-free.app',
    );
  });

  it('keeps a deeper suffix whole, so a paid domain is not over-widened', () => {
    expect(tunnelHostPattern('https://a.b.example.com')).toBe(
      '*.b.example.com',
    );
  });

  it('answers null rather than a mask the guard would have to refuse', () => {
    // Two labels would produce `*.app` — a whole TLD. Refused HERE as well as
    // in the guard, so a bad mask is never even offered.
    expect(tunnelHostPattern('https://evil.app')).toBeNull();
    expect(tunnelHostPattern('not a url')).toBeNull();
  });
});

describe('RemoteTunnel', () => {
  it('starts cloudflared FIRST when both are installed', async () => {
    const { tunnel, child, spawnProcess } = harness();
    const started = tunnel.start(47616);
    child.stderr.push(
      'INF |  https://keyword-portsmouth-product.trycloudflare.com  |\n',
    );
    const state = await started;

    expect(state.status).toBe('open');
    expect(state.provider).toBe('cloudflared');
    expect(state.url).toBe(
      'https://keyword-portsmouth-product.trycloudflare.com',
    );
    expect(spawnProcess).toHaveBeenCalledWith(
      '/opt/homebrew/bin/cloudflared',
      expect.arrayContaining(['tunnel', '--url', 'http://127.0.0.1:47616']),
      expect.anything(),
    );
    // The readiness endpoint is pinned to loopback, never cloudflared's
    // `localhost` default.
    const [, args] = spawnProcess.mock.calls[0] as unknown as [
      string,
      string[],
    ];
    const at = args.indexOf('--metrics');
    expect(args.slice(at, at + 2)).toEqual(['--metrics', '127.0.0.1:0']);
  });

  it('falls back to ngrok when cloudflared is not installed', async () => {
    const { tunnel, child, spawnProcess } = harness({ bins: ['ngrok'] });
    const started = tunnel.start(47616);
    child.stdout.push(
      '{"lvl":"info","msg":"started tunnel","url":"https://9b36-1-2-3-4.ngrok-free.app"}\n',
    );
    const state = await started;

    expect(state.provider).toBe('ngrok');
    expect(state.url).toBe('https://9b36-1-2-3-4.ngrok-free.app');
    expect(spawnProcess).toHaveBeenCalledWith(
      '/opt/homebrew/bin/ngrok',
      expect.arrayContaining(['http', '47616']),
      expect.anything(),
    );
  });

  it('names both clients when neither is installed', async () => {
    const { tunnel, spawnProcess } = harness({ bins: [] });
    const state = await tunnel.start(47616);

    expect(state.status).toBe('error');
    expect(state.error).toContain('cloudflared');
    expect(state.error).toContain('ngrok');
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it('widens the guard only while the tunnel is OPEN', async () => {
    const { tunnel, child } = harness();
    expect(tunnel.allowedHostPattern()).toBeNull();

    const started = tunnel.start(47616);
    child.stderr.push('https://abc.trycloudflare.com\n');
    await started;
    expect(tunnel.allowedHostPattern()).toBe('*.trycloudflare.com');

    await tunnel.stop();
    // The load-bearing half: a mask left standing after the tunnel closed
    // would admit the provider's whole zone for the rest of the launch.
    expect(tunnel.allowedHostPattern()).toBeNull();
  });

  it('kills the client on stop', async () => {
    const { tunnel, child } = harness();
    const started = tunnel.start(47616);
    child.stderr.push('https://abc.trycloudflare.com\n');
    await started;

    await tunnel.stop();
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(tunnel.state().status).toBe('off');
  });

  it('reports a client that dies before producing an address, in its own words', async () => {
    const { tunnel, child } = harness({ bins: ['ngrok'] });
    const started = tunnel.start(47616);
    child.stdout.push('{"err":"authentication failed: token expired"}\n');
    // A stream delivers on the next tick, so an `exit` emitted synchronously
    // after the push would beat the data the failure is reported FROM — the
    // ordering a real dying client has, and the one that makes this assertion
    // about the tail rather than about a race.
    await new Promise((resolve) => setImmediate(resolve));
    child.emit('exit', 1, null);
    const state = await started;

    expect(state.status).toBe('error');
    expect(state.error).toContain('authentication failed');
  });

  it('gives up when the client never reports an address', async () => {
    const { tunnel, child } = harness();
    const state = await tunnel.start(47616);

    expect(state.status).toBe('error');
    expect(state.error).toContain('did not report an address');
    // The wedged client is reaped rather than left running behind a failure
    // the user has already been shown.
    expect(child.kill).toHaveBeenCalled();
  });

  it('follows a URL the client reassigns mid-session', async () => {
    const { tunnel, child } = harness({ bins: ['ngrok'] });
    const started = tunnel.start(47616);
    child.stdout.push('{"url":"https://9b36-1-2-3-4.ngrok-free.app"}\n');
    await started;

    // Measured on a real ngrok session: a reconnect handed out a new
    // subdomain. The mask still admits it; the screen must not go stale.
    child.stdout.push('{"url":"https://5cd3-1-2-3-4.ngrok-free.app"}\n');
    await new Promise((resolve) => setImmediate(resolve));
    expect(tunnel.state().url).toBe('https://5cd3-1-2-3-4.ngrok-free.app');
  });

  it('stops reporting an address once the client that served it has exited', async () => {
    const { tunnel, child, spawnProcess } = harness();
    const started = tunnel.start(47616);
    child.stderr.push('https://abc.trycloudflare.com\n');
    await started;

    child.exitCode = 1;
    child.emit('exit', 1, null);

    expect(tunnel.state().status).toBe('error');
    expect(tunnel.state().url).toBeNull();
    expect(tunnel.allowedHostPattern()).toBeNull();
    // The press that follows must open a NEW client, not be answered with
    // the dead one's address.
    await tunnel.start(47616);
    expect(spawnProcess).toHaveBeenCalledTimes(2);
  });

  it('ignores output the exited client still had buffered', async () => {
    const { tunnel, child } = harness({ bins: ['ngrok'] });
    const started = tunnel.start(47616);
    child.stdout.push('{"url":"https://9b36-1-2-3-4.ngrok-free.app"}\n');
    await started;

    child.exitCode = 1;
    child.emit('exit', 1, null);
    child.stdout.push('{"url":"https://5cd3-1-2-3-4.ngrok-free.app"}\n');
    await new Promise((resolve) => setImmediate(resolve));

    expect(tunnel.state().status).toBe('error');
    expect(tunnel.allowedHostPattern()).toBeNull();
  });

  it('finds the address and the readiness endpoint in lines split across reads', async () => {
    const probeReady = vi.fn(async () => true);
    const child = fakeChild();
    const tunnel = new RemoteTunnel({
      spawnProcess: vi.fn(() => child) as never,
      resolveBin: (name) => `/opt/homebrew/bin/${name}`,
      urlWaitMs: 1_000,
      livenessPollMs: 5,
      probeReady,
    });
    const started = tunnel.start(47616);
    child.stderr.push('INF |  https://driving-table-');
    child.stderr.push('leather-posts.trycloudflare.com  |\n');
    child.stderr.push('INF Starting metrics server on 127.0.0.1:202');
    child.stderr.push('43/metrics\n');

    expect((await started).url).toBe(
      'https://driving-table-leather-posts.trycloudflare.com',
    );
    await vi.waitFor(() => {
      expect(probeReady).toHaveBeenCalledWith('http://127.0.0.1:20243/ready');
    });
    await tunnel.stop();
  });

  describe('a client that stays up after its tunnel is gone', () => {
    // cloudflared, back from a night's sleep, keeps running and retrying
    // a quick tunnel the provider has already deleted: no exit, no new
    // address, only its own readiness endpoint answering "no connection".
    const POLL_MS = 1_000;

    function sleepingHarness() {
      const child = fakeChild();
      let answer: () => Promise<boolean> = async () => true;
      const probed: string[] = [];
      const tunnel = new RemoteTunnel({
        spawnProcess: vi.fn(() => child) as never,
        resolveBin: (name) => `/opt/homebrew/bin/${name}`,
        urlWaitMs: 50,
        livenessPollMs: POLL_MS,
        probeReady: (url) => {
          probed.push(url);
          return answer();
        },
      });
      return {
        tunnel,
        child,
        probed,
        setReady: (ready: boolean) => {
          answer = async () => ready;
        },
        holdNextProbe: () => {
          let release: (ready: boolean) => void = () => undefined;
          answer = () =>
            new Promise<boolean>((resolve) => {
              release = resolve;
            });
          return (ready: boolean) => release(ready);
        },
      };
    }

    async function openWithMetrics(h: ReturnType<typeof sleepingHarness>) {
      const started = h.tunnel.start(47616);
      h.child.stderr.push(
        'INF |  https://driving-table-leather-posts.trycloudflare.com  |\n',
      );
      await started;
      h.child.stderr.push(
        'INF Starting metrics server on 127.0.0.1:20243/metrics\n',
      );
      await vi.advanceTimersByTimeAsync(POLL_MS);
    }

    /** A sleep: no timer runs while the wall clock moves on. */
    function sleep(ms: number): void {
      vi.setSystemTime(Date.now() + ms);
    }

    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('asks the readiness endpoint the client printed', async () => {
      const h = sleepingHarness();
      await openWithMetrics(h);

      expect(h.probed).toContain('http://127.0.0.1:20243/ready');
      expect(h.tunnel.state().status).toBe('open');
    });

    it('reports the address as expired after the Mac slept past the provider deleting it', async () => {
      const h = sleepingHarness();
      await openWithMetrics(h);

      h.setReady(false);
      sleep(8 * 60 * 60_000);
      await vi.advanceTimersByTimeAsync(TUNNEL_EXPIRY_CONFIRM_MS + 2 * POLL_MS);

      expect(h.tunnel.state().status).toBe('error');
      expect(h.tunnel.state().url).toBeNull();
      expect(h.tunnel.state().error).toContain('expired');
      expect(h.tunnel.allowedHostPattern()).toBeNull();
      // The client would otherwise retry a deleted tunnel for the rest of
      // the launch.
      expect(h.child.kill).toHaveBeenCalledWith('SIGTERM');
    });

    it('does not take the first answer after wake as a connection, since the client has not noticed the sleep yet', async () => {
      const h = sleepingHarness();
      await openWithMetrics(h);

      // cloudflared reports its pre-sleep connection as live for a few seconds
      // after wake, until its own idle timeout notices the connection is gone.
      sleep(8 * 60 * 60_000);
      await vi.advanceTimersByTimeAsync(POLL_MS);
      h.setReady(false);
      await vi.advanceTimersByTimeAsync(TUNNEL_EXPIRY_CONFIRM_MS + 2 * POLL_MS);

      expect(h.tunnel.state().status).toBe('error');
      expect(h.tunnel.state().error).toContain('expired');
    });

    it('does not take a probe sent before the sleep and answered after it as a connection', async () => {
      const h = sleepingHarness();
      await openWithMetrics(h);
      const release = h.holdNextProbe();
      await vi.advanceTimersByTimeAsync(POLL_MS);

      sleep(8 * 60 * 60_000);
      release(true);
      h.setReady(false);
      await vi.advanceTimersByTimeAsync(TUNNEL_EXPIRY_CONFIRM_MS + 2 * POLL_MS);

      expect(h.tunnel.state().status).toBe('error');
    });

    it('keeps the address when the tunnel reconnects soon after a wake, however long the sleep', async () => {
      const h = sleepingHarness();
      await openWithMetrics(h);

      // The network is not back for the first answers after wake.
      h.setReady(false);
      sleep(TUNNEL_EXPIRED_AFTER_MS + 60_000);
      await vi.advanceTimersByTimeAsync(5 * POLL_MS);
      h.setReady(true);
      await vi.advanceTimersByTimeAsync(TUNNEL_EXPIRY_CONFIRM_MS);

      expect(h.tunnel.state().status).toBe('open');
      expect(h.child.kill).not.toHaveBeenCalled();
    });

    it('keeps the address through one failed answer after it reconnected from a long sleep', async () => {
      const h = sleepingHarness();
      await openWithMetrics(h);

      sleep(TUNNEL_EXPIRED_AFTER_MS + 60_000);
      await vi.advanceTimersByTimeAsync(3 * POLL_MS);
      h.setReady(false);
      await vi.advanceTimersByTimeAsync(POLL_MS);
      h.setReady(true);
      await vi.advanceTimersByTimeAsync(POLL_MS);

      expect(h.tunnel.state().status).toBe('open');
    });

    it('still reports the address as expired while App Nap stretches the poll of a hidden window', async () => {
      const h = sleepingHarness();
      await openWithMetrics(h);
      const stretchedTick = async (): Promise<void> => {
        sleep(40_000 - POLL_MS);
        await vi.advanceTimersByTimeAsync(POLL_MS);
      };

      for (let i = 0; i < 3; i += 1) {
        await stretchedTick();
      }
      h.setReady(false);
      for (let i = 0; i * 40_000 <= TUNNEL_EXPIRED_AFTER_MS + 40_000; i += 1) {
        await stretchedTick();
      }

      expect(h.tunnel.state().status).toBe('error');
    });

    it('reports the address as expired once a Mac that stays awake has been offline for the expiry window', async () => {
      const h = sleepingHarness();
      await openWithMetrics(h);

      h.setReady(false);
      await vi.advanceTimersByTimeAsync(TUNNEL_EXPIRED_AFTER_MS - 3 * POLL_MS);
      expect(h.tunnel.state().status).toBe('open');

      await vi.advanceTimersByTimeAsync(3 * POLL_MS);
      expect(h.tunnel.state().status).toBe('error');
    });

    it('counts the window from the last answer that had a connection, not from the start', async () => {
      const h = sleepingHarness();
      await openWithMetrics(h);
      await vi.advanceTimersByTimeAsync(TUNNEL_EXPIRED_AFTER_MS + POLL_MS);

      h.setReady(false);
      await vi.advanceTimersByTimeAsync(3 * 60_000);
      h.setReady(true);
      await vi.advanceTimersByTimeAsync(POLL_MS);

      expect(h.tunnel.state().status).toBe('open');
      expect(h.tunnel.state().url).toBe(
        'https://driving-table-leather-posts.trycloudflare.com',
      );
    });
  });

  it('does not start a second client while one is already open', async () => {
    const { tunnel, child, spawnProcess } = harness();
    const started = tunnel.start(47616);
    child.stderr.push('https://abc.trycloudflare.com\n');
    await started;

    await tunnel.start(47616);
    expect(spawnProcess).toHaveBeenCalledTimes(1);
  });
});

describe('probeReady', () => {
  it("answers the readiness endpoint's own verdict, and no connection when nothing answers", async () => {
    let status = 200;
    const server = createServer((req, res) => {
      res.statusCode = req.url === '/ready' ? status : 404;
      res.end();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const { port } = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${String(port)}/ready`;

    expect(await probeReady(url)).toBe(true);
    status = 503;
    expect(await probeReady(url)).toBe(false);

    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(await probeReady(url)).toBe(false);
  });
});
