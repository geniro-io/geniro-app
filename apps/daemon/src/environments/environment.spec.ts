import { describe, expect, it } from 'vitest';

import { DAEMON_PREFERRED_PORT } from '../utils/handshake';
import { environment as devEnvironment } from './environment.dev';
import { environment } from './environment.prod';
import { environment as testEnvironment } from './environment.test';

/**
 * The env factories read `process.env` at CALL time and are pure (no disk IO —
 * the userData mkdir lives in `environments/index.ts`), so each test sets a
 * variable, builds an environment, and restores.
 */
function withEnv(
  vars: Record<string, string | undefined>,
  run: () => void,
): void {
  const saved = Object.keys(vars).map(
    (key) => [key, process.env[key]] as const,
  );
  try {
    for (const [key, value] of Object.entries(vars)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

describe('environment() port resolution', () => {
  it('falls back to the default port when GENIRO_PORT exceeds the TCP max (65535)', () => {
    // 99999999 passes Number.isInteger && >0 but is NOT a bindable TCP port;
    // accepting it makes app.listen throw at boot instead of cleanly falling
    // back. A bindable port must be 1..65535.
    withEnv({ GENIRO_PORT: '99999999' }, () => {
      expect(environment().preferredPort).toBe(DAEMON_PREFERRED_PORT);
    });
  });

  it('falls back to the default port when GENIRO_PORT is given in exponential notation', () => {
    // Number('4e4') === 40000 — an env var of literal "4e4" silently becomes
    // port 40000 instead of being rejected as non-numeric input.
    withEnv({ GENIRO_PORT: '4e4' }, () => {
      expect(environment().preferredPort).toBe(DAEMON_PREFERRED_PORT);
    });
  });

  it('falls back to the default port when GENIRO_PORT is a hex literal', () => {
    // Number('0x1234') === 4660 — an env var of literal "0x1234" silently
    // becomes port 4660 rather than being rejected as malformed.
    withEnv({ GENIRO_PORT: '0x1234' }, () => {
      expect(environment().preferredPort).toBe(DAEMON_PREFERRED_PORT);
    });
  });

  it('honours a real port', () => {
    withEnv({ GENIRO_PORT: '51234' }, () => {
      expect(environment().preferredPort).toBe(51234);
    });
  });
});

describe('environment() idle window', () => {
  it('is off by default — no window unless something names one', () => {
    // The default that keeps `pnpm daemon:dev` and the generate:api daemon up.
    withEnv({ GENIRO_IDLE_EXIT_MS: undefined }, () => {
      expect(environment().idleExitMs).toBeNull();
    });
  });

  it('honours a window the supervisor sets', () => {
    withEnv({ GENIRO_IDLE_EXIT_MS: '600000' }, () => {
      expect(environment().idleExitMs).toBe(600_000);
    });
  });

  it('switches OFF rather than guessing when the value is malformed', () => {
    // The feature terminates the daemon, so an unreadable duration must not be
    // rounded into some number of minutes.
    for (const raw of ['0', '-1', 'soon', '10m', '']) {
      withEnv({ GENIRO_IDLE_EXIT_MS: raw }, () => {
        expect(environment().idleExitMs).toBeNull();
      });
    }
  });
});

describe('environment() userData dir', () => {
  it('honours the path the UI passes', () => {
    withEnv({ GENIRO_USER_DATA: '/tmp/geniro-somewhere' }, () => {
      expect(environment().userDataDir).toBe('/tmp/geniro-somewhere');
    });
  });

  it('keeps a path that getEnv would have boolean-coerced', () => {
    // `getEnv` turns '0'/'on'/'off' into booleans. A userData dir named "0" is
    // absurd but a `join(false, …)` crash on boot is worse than absurd, and
    // this is the pin on reading the raw variable instead.
    withEnv({ GENIRO_USER_DATA: '/tmp/0' }, () => {
      expect(environment().userDataDir).toBe('/tmp/0');
    });
  });

  it('derives the db and pidfile paths from it', () => {
    withEnv({ GENIRO_USER_DATA: '/tmp/geniro-derive' }, () => {
      const env = environment();
      expect(env.dbPath).toBe('/tmp/geniro-derive/geniro.db');
      expect(env.pidfilePath).toBe('/tmp/geniro-derive/daemon.json');
    });
  });
});

describe('environment layering', () => {
  it('binds loopback in every environment — never a routable address', () => {
    // A hard v1 constraint, and the reason `host` is a constant rather than an
    // env knob. If it ever becomes one, this is what fails.
    expect(environment().host).toBe('127.0.0.1');
    expect(devEnvironment().host).toBe('127.0.0.1');
    expect(testEnvironment().host).toBe('127.0.0.1');
  });

  it('inherits prod fields into dev, and dev fields into test', () => {
    // The layering itself: test spreads DEV (not prod), so a field added to
    // dev reaches tests without an edit here.
    withEnv({ GENIRO_USER_DATA: '/tmp/geniro-layer' }, () => {
      expect(devEnvironment().userDataDir).toBe('/tmp/geniro-layer');
      expect(testEnvironment().userDataDir).toBe('/tmp/geniro-layer');
      expect(testEnvironment().preferredPort).toBe(DAEMON_PREFERRED_PORT);
    });
  });

  it('keeps the test log stream quiet, unlike dev', () => {
    // Inheriting dev's pretty debug output would bury unit-test assertions in
    // the daemon's own log stream.
    withEnv({ LOG_LEVEL: undefined, PRETTY_LOGS: undefined }, () => {
      expect(devEnvironment().prettyLog).toBe(true);
      expect(testEnvironment().prettyLog).toBe(false);
      expect(testEnvironment().logLevel).toBe('info');
    });
  });
});
