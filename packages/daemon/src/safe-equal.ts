import { timingSafeEqual } from 'node:crypto';

/**
 * Constant-time string comparison — avoids a timing oracle on the loopback
 * token. Shared by the HTTP guard and the WS handshake so both auth paths gate
 * the token with the same rigor.
 */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
