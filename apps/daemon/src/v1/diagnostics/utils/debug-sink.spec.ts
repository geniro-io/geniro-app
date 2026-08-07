import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { configureDebugSink, debugSink } from './debug-sink';
import { clearSecrets, registerSecret } from './redact';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'sink-spec-'));
}

/** Read every line the sink wrote, across rotations. */
function fileEntries(dir: string): { channel: string; message: string }[] {
  return readdirSync(dir)
    .flatMap((name) => readFileSync(join(dir, name), 'utf8').split('\n'))
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as { channel: string; message: string });
}

beforeEach(() => {
  // Memory-only unless a test asks for a file, so no spec litters the disk.
  configureDebugSink({ dir: null });
  debugSink.setChannels(['daemon', 'transcript', 'ui', 'agent-stdio']);
});

afterEach(() => {
  debugSink.close();
  clearSecrets();
});

describe('debugSink channels', () => {
  it('drops an entry on a channel that is off, and says so by returning null', () => {
    debugSink.setChannels(['daemon']);

    expect(debugSink.record('daemon', 'info', 'kept')).not.toBeNull();
    expect(debugSink.record('agent-stdio', 'trace', 'dropped')).toBeNull();
    expect(debugSink.since(-1).entries.map((e) => e.message)).toEqual(['kept']);
  });

  it('reports which channels are on', () => {
    debugSink.setChannels(['daemon', 'ui']);

    expect(debugSink.enabledChannels().sort()).toEqual(['daemon', 'ui']);
    expect(debugSink.isEnabled('agent-stdio')).toBe(false);
  });
});

describe('debugSink ordering and the read cursor', () => {
  it('issues a strictly increasing seq', () => {
    for (let i = 0; i < 5; i++) {
      debugSink.record('daemon', 'info', `line ${i}`);
    }

    const seqs = debugSink.since(-1).entries.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it('returns only what is newer than the cursor', () => {
    debugSink.record('daemon', 'info', 'first');
    const after = debugSink.lastSeq();
    debugSink.record('daemon', 'info', 'second');

    expect(debugSink.since(after - 1).entries.map((e) => e.message)).toEqual([
      'second',
    ]);
  });

  it('hands back the TAIL when more matches than the limit', () => {
    // A reader catching up wants the newest lines. Dropping the newest to
    // honour a limit would return a page that never advances to the present,
    // so the reader would poll forever and never catch up.
    for (let i = 0; i < 10; i++) {
      debugSink.record('daemon', 'info', `line ${i}`);
    }

    expect(debugSink.since(-1, 3).entries.map((e) => e.message)).toEqual([
      'line 7',
      'line 8',
      'line 9',
    ]);
  });
});

describe('debugSink redaction', () => {
  it('scrubs a secret at the ONE door every entry passes through', () => {
    // Redaction lives in `record`, not at each source, so a source added later
    // is protected without its author knowing it has to be.
    const secret = 'z'.repeat(40);
    registerSecret(secret, 'launch token');

    debugSink.record('agent-stdio', 'trace', `--token ${secret}`, {
      url: `http://x/${secret}`,
    });

    const [entry] = debugSink.since(-1).entries;
    expect(entry!.message).not.toContain(secret);
    // The CONTEXT too — a secret is just as leaked from a field as from a
    // message, and the context is what carries URLs.
    expect(JSON.stringify(entry!.context)).not.toContain(secret);
    expect(entry!.context?.url).toContain('launch token redacted');
  });
});

describe('debugSink file', () => {
  it('writes entries to a 0600 JSONL file', async () => {
    const dir = tempDir();
    configureDebugSink({ dir });

    debugSink.record('daemon', 'info', 'to disk');
    await until(() => readdirSync(dir).length === 1);

    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    // 0600: the file holds the daemon's account of the user's own source tree.
    expect(statSync(join(dir, files[0]!)).mode & 0o777).toBe(0o600);
    expect(fileEntries(dir).map((e) => e.message)).toContain('to disk');
  });

  it('rotates past the size ceiling and keeps only the newest files', async () => {
    const dir = tempDir();
    // Tiny ceiling so a rotation is provoked in-process rather than by
    // writing 8MB — the behaviour is the same, the spec is not 8MB long.
    configureDebugSink({ dir, maxFileBytes: 200, maxFiles: 2, now: stamps() });

    for (let i = 0; i < 30; i++) {
      debugSink.record('daemon', 'info', `line ${i} ${'x'.repeat(40)}`);
    }

    // Waits for the count to STOP CHANGING, not for it to be small. Waiting
    // for "small" passes the instant it is read — right after the loop the
    // opens are still pending and the directory is empty, so the assertion
    // would hold before a single rotation had happened, and hold just as well
    // with pruning deleted.
    expect(await settledCount(dir)).toBeLessThanOrEqual(2);
  });

  it('keeps recording in memory when the file cannot be written', () => {
    // A broken log file must degrade to memory-only, never throw: `record` is
    // called from inside the logger and from stream handlers, where an
    // exception would take down the thing being logged about.
    configureDebugSink({ dir: '/dev/null/not-a-directory' });

    expect(() =>
      debugSink.record('daemon', 'error', 'still here'),
    ).not.toThrow();
    expect(debugSink.since(-1).entries.map((e) => e.message)).toEqual([
      'still here',
    ]);
    expect(debugSink.filePath()).toBeNull();
  });

  it('truncates an enormous line, and says how much it cut', () => {
    // The count is part of the line, so a reader can tell a long-but-complete
    // payload from one this cut — which changes whether the log is evidence.
    debugSink.record('agent-stdio', 'trace', 'y'.repeat(20_000));

    const [entry] = debugSink.since(-1).entries;
    expect(entry!.message.length).toBeLessThan(20_000);
    expect(entry!.message).toContain('chars truncated');
  });
});

/**
 * Wait for the filesystem to actually reach `condition`, polling.
 *
 * The sink's file work is asynchronous end to end — `createWriteStream` opens
 * asynchronously and buffers until it has a handle, and a rotated file only
 * becomes prunable on its stream's `'close'` event — so a read taken right
 * after `record` sees a directory mid-flight.
 *
 * This replaced a fixed 20ms sleep, which was a real flake and not a
 * theoretical one: it held when this spec ran alone and failed inside
 * `pnpm full-check`, where the daemon and UI suites run at once and ~15
 * rotations' worth of opens and closes no longer fit in the window. A sleep
 * encodes a guess about machine load; this waits for the thing itself.
 *
 * It does NOT swallow a failure: on timeout it returns anyway, leaving the
 * caller's own `expect` to report the real state. A helper that threw
 * "timed out" here would hide which count was actually on disk.
 */
async function until(
  condition: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * How many log files remain once the directory stops changing.
 *
 * Rotation is a burst of asynchronous work — an open and a close per file,
 * with the prune riding the close — so the count RISES and then falls. Any
 * wait phrased as "until it is small enough" is satisfied by the empty
 * directory that exists before the first open lands, which is how a version
 * of this spec passed with pruning disabled entirely.
 *
 * Quiescence is the honest signal: read until several consecutive reads agree,
 * then answer with that. On timeout it answers with the last read rather than
 * throwing, so the caller's own assertion reports the real number.
 */
async function settledCount(dir: string, timeoutMs = 5_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let last = -1;
  let stable = 0;
  while (Date.now() < deadline) {
    const count = readdirSync(dir).length;
    stable = count === last ? stable + 1 : 0;
    last = count;
    // Five agreeing reads, 20ms apart: long enough to span one pending
    // open+close pair, which is the shortest thing that could still change it.
    if (stable >= 5 && count > 0) {
      return count;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return last;
}

/** Distinct ISO stamps, so each rotation lands on its own filename. */
function stamps(): () => Date {
  let tick = 0;
  return () => new Date(1_700_000_000_000 + tick++ * 1_000);
}
