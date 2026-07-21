/**
 * Defensive newline-delimited-JSON reassembler for a child process's stdout.
 *
 * A CLI's `--output-format stream-json` stream arrives as arbitrary chunks: a
 * single JSON object can be split across two `data` events, and several can land
 * in one. This buffer reassembles whole lines, parses each independently, and —
 * crucially for the spec's HIGH Cursor-schema-drift risk — never throws on a
 * malformed line: a bad line is reported and skipped so one unparseable event
 * can't kill the turn. Unknown-but-valid JSON objects are passed through; the
 * adapter's mapper decides what to ignore.
 */
export interface NdjsonBufferOptions {
  /** Called for each successfully parsed JSON value, in stream order. */
  onObject: (obj: unknown) => void;
  /**
   * Called when a non-empty line fails to parse as JSON. Defaults to a no-op
   * (skip) — defensiveness means a malformed line degrades gracefully.
   */
  onParseError?: (line: string, error: unknown) => void;
}

/**
 * Cap on the un-newlined reassembly buffer — the same bounded-buffer
 * discipline as spawn-cli's stderr tail and the PTY scrollback cap. The
 * spawned binary is user-configurable, and one that streams bytes without a
 * newline would otherwise grow `buf` for the turn's whole lifetime. A real
 * stream-json line never approaches this; an overflowing prefix is dropped
 * and reported through `onParseError`.
 */
export const MAX_BUFFERED_LINE_CHARS = 8 * 1024 * 1024;

export class NdjsonBuffer {
  private buf = '';

  constructor(private readonly opts: NdjsonBufferOptions) {}

  /** Feed a stdout chunk; emits every complete line it now contains. */
  push(chunk: string): void {
    this.buf += chunk;
    let nl = this.buf.indexOf('\n');
    while (nl !== -1) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      this.consume(line);
      nl = this.buf.indexOf('\n');
    }
    if (this.buf.length > MAX_BUFFERED_LINE_CHARS) {
      const droppedLength = this.buf.length;
      const preview = this.buf.slice(0, 256);
      this.buf = '';
      this.opts.onParseError?.(
        preview,
        new Error(
          `oversized un-terminated line dropped (${droppedLength} chars buffered)`,
        ),
      );
    }
  }

  /**
   * Emit any trailing line left in the buffer at end-of-stream. Some CLIs do
   * not terminate the final object with a newline, so the last event would be
   * lost without this.
   */
  flush(): void {
    if (this.buf.length === 0) {
      return;
    }
    const line = this.buf;
    this.buf = '';
    this.consume(line);
  }

  private consume(rawLine: string): void {
    // `.trim()` also strips a trailing `\r` from CRLF streams and skips the
    // blank lines some CLIs emit between objects.
    const line = rawLine.trim();
    if (line.length === 0) {
      return;
    }
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch (error) {
      this.opts.onParseError?.(line, error);
      return;
    }
    this.opts.onObject(obj);
  }
}
