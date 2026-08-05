/** How much output a terminal session retains for (re)attach replay, in chars. */
export const SCROLLBACK_CAP = 512 * 1024;

/**
 * A bounded append-only text buffer: newest-wins, oldest chunks dropped past
 * {@link SCROLLBACK_CAP}.
 *
 * The retention half of a terminal session's scrollback
 * (`TerminalSessionsService`), kept as its own unit because the trim rule below
 * is worth stating once and testing directly.
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
