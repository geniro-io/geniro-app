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
 * `basename` catches the separator forms — `../x`, absolute paths, trailing
 * separators — because `/` is the only separator POSIX recognises. It does NOT
 * catch the two RELATIVE names, which are their own basename: measured,
 * `basename('..') === '..'`, so `join(store, '..', 'meta.json')` resolves one
 * directory above the store. Whether that escapes depends on the sink, which is
 * why it is refused here rather than reasoned about per caller — an id used as a
 * FILENAME survives it (`'..' + '.jsonl'` is an ordinary name), but one used as
 * a DIRECTORY component does not.
 *
 * A legitimate id cannot fail this. Every id a picker offers was derived from a
 * FILENAME by the listing that produced it, so it has no separator to lose, and
 * no CLI names a conversation `.` or `..`.
 */
export function isPlainSessionId(sessionId: string): boolean {
  return (
    sessionId !== '' &&
    sessionId !== '.' &&
    sessionId !== '..' &&
    sessionId === basename(sessionId)
  );
}

/** The sentence a refused id carries, shared so both sites say the same thing. */
export const SESSION_ID_INVALID_MESSAGE =
  'A session id names one conversation, not a path.';
