/**
 * How much output either mirror retains for (re)attach replay, in chars.
 *
 * ONE constant, not two that a comment claims are equal: the live mirror's
 * buffer and the PTY session's scrollback are the same thing to a reader — the
 * history the panel replays — so a panel must not hold a different amount of it
 * depending on which kind it opened.
 */
export const SCROLLBACK_CAP = 512 * 1024;

/**
 * A bounded append-only text buffer: newest-wins, oldest chunks dropped past
 * {@link SCROLLBACK_CAP}.
 *
 * Extracted rather than written twice. It is the retention half of BOTH
 * terminal mirrors — `TurnMirrorService`'s per-(run, node) buffer and
 * `TerminalSessionsService`'s per-session scrollback — and a second copy is how the two
 * silently drift on the cap or on the trim rule.
 *
 * Trimming stops at ONE chunk, so a single write larger than the cap is kept
 * whole: emptying the buffer to satisfy the cap would blank a mirror whose turn
 * is actively producing output, which is worse than briefly exceeding it.
 */
export class CappedTextBuffer {
  private chunks: string[] = [];
  private length = 0;

  constructor(private readonly cap: number = SCROLLBACK_CAP) {}

  /** Append one chunk. Returns false for an empty write, which is a no-op. */
  push(text: string): boolean {
    if (text.length === 0) {
      return false;
    }
    this.chunks.push(text);
    this.length += text.length;
    while (this.length > this.cap && this.chunks.length > 1) {
      this.length -= this.chunks.shift()?.length ?? 0;
    }
    return true;
  }

  /** Everything retained, for a client attaching now. */
  snapshot(): string {
    return this.chunks.join('');
  }
}
