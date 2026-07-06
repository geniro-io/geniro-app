import { randomBytes } from 'node:crypto';

/**
 * Mint a loopback session/credential token (256 bits, hex). The launch token
 * (pidfile) and the per-run/per-node MCP call tokens all come from here — one
 * mint for every loopback credential, sitting in `auth/` beside the guard
 * rather than in the pidfile util.
 */
export function mintToken(): string {
  return randomBytes(32).toString('hex');
}
