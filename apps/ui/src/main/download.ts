import { createHash, type Hash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** A text asset (a checksum file) is small; a minute is already generous. */
const FETCH_TEXT_TIMEOUT_MS = 60_000;

export interface DownloadProgress {
  /** 0–1, or null while the server has not declared a length. */
  fraction: number | null;
  receivedBytes: number;
  totalBytes: number | null;
}

export interface DownloadOptions {
  onProgress?: (progress: DownloadProgress) => void;
  /** Abandon the download. The partial file is left in place for the caller. */
  signal?: AbortSignal;
  /** A total budget for the whole transfer. Absent, there is none. */
  timeoutMs?: number;
  /** Abort when no byte has arrived for this long. */
  stallTimeoutMs?: number;
  /** Continue a partial file at `dest` with a Range request, when the server allows it. */
  resume?: boolean;
}

export class DownloadHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export class DownloadStalledError extends Error {}

/**
 * The caller's abandon signal and the step's own limits, as one signal.
 *
 * `AbortSignal.any` is what makes them a single thing every `fetch` below can
 * take; an absent limit simply does not take part.
 */
function anySignal(signals: readonly (AbortSignal | undefined)[]): AbortSignal {
  return AbortSignal.any(
    signals.filter((s): s is AbortSignal => s !== undefined),
  );
}

interface StallGuard {
  readonly signal: AbortSignal;
  stalled: boolean;
  touch(): void;
  stop(): void;
}

/**
 * Aborts its signal when {@link StallGuard.touch} has not been called for `ms`.
 * Armed by the first touch and re-armed by every chunk; without `ms` it never
 * fires.
 */
function stallGuard(ms: number | undefined): StallGuard {
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard: StallGuard = {
    signal: abort.signal,
    stalled: false,
    touch() {
      if (ms === undefined) {
        return;
      }
      clearTimeout(timer);
      timer = setTimeout(() => {
        guard.stalled = true;
        abort.abort();
      }, ms);
    },
    stop() {
      clearTimeout(timer);
    },
  };
  return guard;
}

async function partialSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return 0;
    }
    throw err;
  }
}

async function hashFile(path: string, hash: Hash): Promise<void> {
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
  }
}

function declaredLength(res: Response): number | null {
  const declared = Number(res.headers.get('content-length'));
  return Number.isFinite(declared) && declared > 0 ? declared : null;
}

/** Fetch a text asset (the checksum file). */
export async function fetchText(
  url: string,
  signal?: AbortSignal,
): Promise<string> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'geniro-app' },
    signal: anySignal([signal, AbortSignal.timeout(FETCH_TEXT_TIMEOUT_MS)]),
  });
  if (!res.ok) {
    throw new DownloadHttpError(
      res.status,
      `HTTP ${res.status} fetching ${basename(url)}`,
    );
  }
  return res.text();
}

/**
 * Stream a URL to disk, reporting progress, and return the sha256 of what was
 * actually written.
 *
 * Hashed on the way through rather than by re-reading the file: the bytes that
 * were written are exactly the bytes that were hashed. The one exception is a
 * resumed file, whose existing bytes are read once before the request, so the
 * digest still covers the whole file.
 */
export async function downloadTo(
  url: string,
  dest: string,
  options: DownloadOptions = {},
): Promise<string> {
  const {
    onProgress,
    signal,
    timeoutMs,
    stallTimeoutMs,
    resume = false,
  } = options;

  let offset = resume ? await partialSize(dest) : 0;
  let hash = createHash('sha256');
  if (offset > 0) {
    await hashFile(dest, hash);
  }

  const stall = stallGuard(stallTimeoutMs);
  const fetchSignal = anySignal([
    stall.signal,
    signal,
    timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs),
  ]);
  const request = (from: number): Promise<Response> =>
    fetch(url, {
      headers: {
        'User-Agent': 'geniro-app',
        ...(from > 0 ? { Range: `bytes=${from}-` } : {}),
      },
      signal: fetchSignal,
    });

  try {
    stall.touch();
    let res = await request(offset);
    if (res.status === 416 && offset > 0) {
      await res.body?.cancel().catch(() => undefined);
      const total = Number(
        /^bytes \*\/(\d+)$/.exec(res.headers.get('content-range') ?? '')?.[1],
      );
      if (total === offset) {
        onProgress?.({
          fraction: 1,
          receivedBytes: offset,
          totalBytes: offset,
        });
        return hash.digest('hex');
      }
      offset = 0;
      hash = createHash('sha256');
      res = await request(0);
    }
    if (!res.ok) {
      throw new DownloadHttpError(
        res.status,
        `HTTP ${res.status} downloading ${basename(url)}`,
      );
    }
    if (!res.body) {
      throw new Error('the download returned no body');
    }

    const ranged = res.status === 206;
    let received = 0;
    let total: number | null;
    if (ranged) {
      const range = /^bytes (\d+)-\d+\/(\d+|\*)$/.exec(
        res.headers.get('content-range') ?? '',
      );
      if (!range || Number(range[1]) !== offset) {
        throw new Error(
          `the server answered a range that does not follow the ${offset} bytes already on disk`,
        );
      }
      received = offset;
      total = range[2] === '*' ? null : Number(range[2]);
    } else {
      hash = createHash('sha256');
      total = declaredLength(res);
    }

    const source = Readable.fromWeb(
      res.body as Parameters<typeof Readable.fromWeb>[0],
    );
    source.on('data', (chunk: Buffer) => {
      hash.update(chunk);
      received += chunk.length;
      stall.touch();
      onProgress?.({
        fraction: total ? Math.min(received / total, 1) : null,
        receivedBytes: received,
        totalBytes: total,
      });
    });
    await pipeline(
      source,
      createWriteStream(dest, { flags: ranged ? 'a' : 'w' }),
    );
    return hash.digest('hex');
  } catch (err) {
    if (stall.stalled) {
      throw new DownloadStalledError(
        `no data from ${basename(url)} for ${stallTimeoutMs} ms`,
      );
    }
    if (signal?.aborted) {
      throw signal.reason;
    }
    throw err;
  } finally {
    stall.stop();
  }
}

/**
 * Parse `shasum -a 256` output into name → digest.
 *
 * The format is `<64 hex>  <name>` per line (two spaces, or ` *` in binary
 * mode). Anything that does not match that is skipped rather than throwing —
 * the file is allowed to carry entries for assets this app never downloads.
 */
export function parseChecksums(text: string): Map<string, string> {
  const digests = new Map<string, string>();
  for (const line of text.split('\n')) {
    const m = /^([0-9a-fA-F]{64})\s+\*?(\S.*)$/.exec(line.trim());
    if (m) {
      digests.set(m[2]!.trim(), m[1]!.toLowerCase());
    }
  }
  return digests;
}
