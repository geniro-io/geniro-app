import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DAEMON_PREFERRED_PORT } from '../utils/handshake';
import { environment } from './environment.prod';

/**
 * `environment()` reads process.env at call time — the env factories are pure
 * (no disk IO; the userData mkdir lives in `environments/index.ts`). Each test
 * sets GENIRO_PORT, builds the prod environment, then restores the env.
 */
describe('environment() port resolution', () => {
  let savedPort: string | undefined;

  beforeEach(() => {
    savedPort = process.env.GENIRO_PORT;
  });

  afterEach(() => {
    if (savedPort === undefined) {
      delete process.env.GENIRO_PORT;
    } else {
      process.env.GENIRO_PORT = savedPort;
    }
  });

  it('falls back to the default port when GENIRO_PORT exceeds the TCP max (65535)', () => {
    // 99999999 passes Number.isInteger && >0 but is NOT a bindable TCP port;
    // accepting it makes app.listen throw at boot instead of cleanly falling
    // back. A bindable port must be 1..65535.
    process.env.GENIRO_PORT = '99999999';
    expect(environment().preferredPort).toBe(DAEMON_PREFERRED_PORT);
  });

  it('falls back to the default port when GENIRO_PORT is given in exponential notation', () => {
    // Number('4e4') === 40000 — an env var of literal "4e4" silently becomes
    // port 40000 instead of being rejected as non-numeric input.
    process.env.GENIRO_PORT = '4e4';
    expect(environment().preferredPort).toBe(DAEMON_PREFERRED_PORT);
  });

  it('falls back to the default port when GENIRO_PORT is a hex literal', () => {
    // Number('0x1234') === 4660 — an env var of literal "0x1234" silently
    // becomes port 4660 rather than being rejected as malformed.
    process.env.GENIRO_PORT = '0x1234';
    expect(environment().preferredPort).toBe(DAEMON_PREFERRED_PORT);
  });
});
