import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

import { PAIRING_CODE_LENGTH } from '../../shared/remote';
import {
  PAIRING_CODE_TTL_MS,
  PAIRING_LOCKOUT_MS,
  PAIRING_MAX_ATTEMPTS,
  PAIRING_MAX_GLOBAL_ATTEMPTS,
  PAIRING_MAX_TRACKED_ADDRESSES,
} from './remote.types';

export interface PairingOptions {
  /** Injected so a spec can drive the TTL and the lockout without real timers. */
  clock?: () => number;
}

export type PairingVerifyResult =
  | { outcome: 'accepted' }
  | { outcome: 'incorrect'; attemptsRemaining: number }
  | { outcome: 'locked'; retryAfterMs: number };

interface AttemptState {
  count: number;
  lockedUntil: number | null;
}

/**
 * Equal-length compare in constant time. `timingSafeEqual` THROWS on a
 * length mismatch rather than returning false, so the length has to be
 * checked first — and a mismatch there is itself decided by length alone,
 * which is fine: a presented code of the wrong length was never going to
 * match and costs no comparison of digits either way.
 */
function codesMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/** The 6-digit pairing code, its lockout, and the tokens a paired device gets. */
export class Pairing {
  private readonly clock: () => number;
  private codeValue: string | null = null;
  private codeIssuedAt: number | null = null;
  private readonly attempts = new Map<string, AttemptState>();
  private globalAttempts = 0;
  private globalLockedUntil: number | null = null;

  constructor(options: PairingOptions = {}) {
    this.clock = options.clock ?? (() => Date.now());
  }

  /** The live code, minting one if none exists or the TTL has passed. */
  currentCode(): string {
    const now = this.clock();
    if (
      this.codeValue === null ||
      this.codeIssuedAt === null ||
      now - this.codeIssuedAt >= PAIRING_CODE_TTL_MS
    ) {
      return this.mintCode();
    }
    return this.codeValue;
  }

  /** Forces a new code regardless of the current one's age. */
  rotate(): string {
    return this.mintCode();
  }

  /**
   * When the live code stops being accepted, or null if none has been minted.
   *
   * Read-only, and it does NOT mint one: Settings draws this beside the code
   * to say how long it stands, and a getter that minted would rotate the
   * user's code every time the panel refreshed.
   */
  codeExpiresAt(): number | null {
    return this.codeIssuedAt === null
      ? null
      : this.codeIssuedAt + PAIRING_CODE_TTL_MS;
  }

  /**
   * Verdict for a presented code from a given remote address. A lockout is
   * checked BEFORE the code is compared — a correct code offered while
   * locked is still refused, since a script that got the code right on
   * attempt six learned nothing it should be trusted with.
   */
  verify(code: string, remoteAddress: string): PairingVerifyResult {
    const now = this.clock();

    // The global ceiling is checked first and answers for everyone: once it
    // has tripped, WHICH address is asking stops being a question worth
    // answering, and letting a fresh address past it here is exactly the
    // bypass the ceiling exists to close.
    if (this.globalLockedUntil !== null) {
      if (this.globalLockedUntil > now) {
        return {
          outcome: 'locked',
          retryAfterMs: this.globalLockedUntil - now,
        };
      }
      this.globalLockedUntil = null;
      this.globalAttempts = 0;
      this.attempts.clear();
    }

    const state = this.attempts.get(remoteAddress);
    if (state?.lockedUntil !== null && state?.lockedUntil !== undefined) {
      if (state.lockedUntil > now) {
        return { outcome: 'locked', retryAfterMs: state.lockedUntil - now };
      }
      // The lockout has expired: the address gets a clean slate rather than
      // carrying a stale count into its next attempt.
      this.attempts.delete(remoteAddress);
    }

    const reference = this.currentCode();
    if (codesMatch(code, reference)) {
      // A code that paired one device must not silently pair a second.
      this.attempts.delete(remoteAddress);
      this.globalAttempts = 0;
      this.rotate();
      return { outcome: 'accepted' };
    }

    this.globalAttempts += 1;
    if (this.globalAttempts >= PAIRING_MAX_GLOBAL_ATTEMPTS) {
      // Rotating matters more than the lockout: the window closes for a few
      // minutes, but the code being guessed at stops existing outright, so
      // whatever the attacker has already ruled out buys them nothing.
      this.rotate();
      this.globalLockedUntil = now + PAIRING_LOCKOUT_MS;
      return { outcome: 'locked', retryAfterMs: PAIRING_LOCKOUT_MS };
    }

    const nextCount = (this.attempts.get(remoteAddress)?.count ?? 0) + 1;
    if (nextCount >= PAIRING_MAX_ATTEMPTS) {
      this.rememberAttempt(remoteAddress, {
        count: nextCount,
        lockedUntil: now + PAIRING_LOCKOUT_MS,
      });
      return { outcome: 'locked', retryAfterMs: PAIRING_LOCKOUT_MS };
    }
    this.rememberAttempt(remoteAddress, {
      count: nextCount,
      lockedUntil: null,
    });
    return {
      outcome: 'incorrect',
      attemptsRemaining: PAIRING_MAX_ATTEMPTS - nextCount,
    };
  }

  /** 256 bits, hex-encoded — the token a paired device presents on every later request. */
  mintSessionToken(): string {
    return randomBytes(32).toString('hex');
  }

  /**
   * Records an address's attempt state, evicting the oldest tracked address
   * once the table is full. `Map` iterates in insertion order, so the first
   * key it yields is the least recently ADDED — good enough here, since the
   * table exists to slow a stranger down rather than to be an accurate LRU.
   */
  private rememberAttempt(remoteAddress: string, state: AttemptState): void {
    if (
      !this.attempts.has(remoteAddress) &&
      this.attempts.size >= PAIRING_MAX_TRACKED_ADDRESSES
    ) {
      const oldest = this.attempts.keys().next();
      if (!oldest.done) {
        this.attempts.delete(oldest.value);
      }
    }
    this.attempts.set(remoteAddress, state);
  }

  private mintCode(): string {
    const code = randomInt(10 ** PAIRING_CODE_LENGTH)
      .toString()
      .padStart(PAIRING_CODE_LENGTH, '0');
    this.codeValue = code;
    this.codeIssuedAt = this.clock();
    return code;
  }
}
