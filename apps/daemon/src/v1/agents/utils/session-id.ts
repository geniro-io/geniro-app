import { basename } from 'node:path';

/**
 * Is this session id one path segment, and nothing else?
 *
 * The id arrives from the HTTP body (`resumeSessionId`) and every adapter turns
 * it into a filesystem path — claude joins it under `projects/<dir>/`, cursor
 * joins it three times over (the source it copies from, the destination, and
 * the staging directory a `rm -r` later takes). So the id is an untrusted
 * string that reaches path sinks, and the check belongs somewhere both adapters
 * and the service seam above them can reach it, rather than re-derived per CLI
 * — which is how one of them came to be guarded and the other not.
 *
 * `basename` is the whole test because `/` is the only separator POSIX
 * recognises: `..`, absolute forms and trailing separators all fail the
 * comparison before any `join` sees them, and a bare `..` becomes the ordinary
 * filename `...jsonl` once a suffix is appended rather than a traversal.
 *
 * A legitimate id cannot fail it. Every id a picker offers was derived from a
 * FILENAME by the listing that produced it, so it has no separator to lose.
 */
export function isPlainSessionId(sessionId: string): boolean {
  return sessionId !== '' && sessionId === basename(sessionId);
}

/** The sentence a refused id carries, shared so both sites say the same thing. */
export const SESSION_ID_INVALID_MESSAGE =
  'A session id names one conversation, not a path.';
