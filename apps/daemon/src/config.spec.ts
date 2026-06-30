import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig } from './config';
import { DAEMON_PREFERRED_PORT } from './handshake';

/**
 * loadConfig() reads process.env and creates userDataDir on disk. We point
 * GENIRO_USER_DATA at a throwaway temp dir so the only side effect is a temp
 * mkdir we clean up; every test restores the env it touched.
 */
describe('loadConfig port resolution', () => {
  let dir: string;
  let savedPort: string | undefined;
  let savedUserData: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'geniro-config-'));
    savedPort = process.env.GENIRO_PORT;
    savedUserData = process.env.GENIRO_USER_DATA;
    process.env.GENIRO_USER_DATA = dir;
  });

  afterEach(() => {
    if (savedPort === undefined) {
      delete process.env.GENIRO_PORT;
    } else {
      process.env.GENIRO_PORT = savedPort;
    }
    if (savedUserData === undefined) {
      delete process.env.GENIRO_USER_DATA;
    } else {
      process.env.GENIRO_USER_DATA = savedUserData;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('falls back to the default port when GENIRO_PORT exceeds the TCP max (65535)', () => {
    // 99999999 passes Number.isInteger && >0 but is NOT a bindable TCP port;
    // accepting it makes app.listen throw at boot instead of cleanly falling
    // back. A bindable port must be 1..65535.
    process.env.GENIRO_PORT = '99999999';
    const cfg = loadConfig();
    expect(cfg.preferredPort).toBe(DAEMON_PREFERRED_PORT);
  });

  it('falls back to the default port when GENIRO_PORT is given in exponential notation', () => {
    // Number('4e4') === 40000 — an env var of literal "4e4" silently becomes
    // port 40000 instead of being rejected as non-numeric input.
    process.env.GENIRO_PORT = '4e4';
    const cfg = loadConfig();
    expect(cfg.preferredPort).toBe(DAEMON_PREFERRED_PORT);
  });

  it('falls back to the default port when GENIRO_PORT is a hex literal', () => {
    // Number('0x1234') === 4660 — an env var of literal "0x1234" silently
    // becomes port 4660 rather than being rejected as malformed.
    process.env.GENIRO_PORT = '0x1234';
    const cfg = loadConfig();
    expect(cfg.preferredPort).toBe(DAEMON_PREFERRED_PORT);
  });
});
