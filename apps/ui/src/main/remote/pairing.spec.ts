import { beforeEach, describe, expect, it, vi } from 'vitest';

// `randomInt` has to be deterministic for the rotation tests (a real random
// 6-digit draw has a 1-in-a-million chance of colliding with itself, which
// this repo's "no flaky tests" rule treats as a bug to remove, not accept).
// `vi.mock` a whole module rather than `vi.spyOn` a single export: Vitest
// runs ESM here, whose module namespace objects are non-configurable, so a
// spy on one named export of `node:crypto` throws "Cannot redefine
// property". The mock keeps every other export real and gives tests a
// default (non-deterministic, but only ever asserted on FORMAT) fallback so
// tests that don't care about the exact digits need no per-test setup.
const { randomIntMock } = vi.hoisted(() => ({ randomIntMock: vi.fn() }));

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, randomInt: randomIntMock };
});

const { Pairing } = await import('./pairing');
const { PAIRING_CODE_LENGTH } = await import('../../shared/remote');
const {
  PAIRING_CODE_TTL_MS,
  PAIRING_LOCKOUT_MS,
  PAIRING_MAX_ATTEMPTS,
  PAIRING_MAX_GLOBAL_ATTEMPTS,
  PAIRING_MAX_TRACKED_ADDRESSES,
} = await import('./remote.types');

function makeClock(start = 0): {
  clock: () => number;
  advance: (ms: number) => void;
} {
  let value = start;
  return { clock: () => value, advance: (ms: number) => (value += ms) };
}

/** A 6-digit code guaranteed to differ from `code` at the first digit. */
function wrongCodeFor(code: string): string {
  const firstDigit = Number(code[0]);
  const flipped = (firstDigit + 1) % 10;
  return `${flipped}${code.slice(1)}`;
}

beforeEach(() => {
  randomIntMock.mockReset();
  randomIntMock.mockImplementation((max: number) =>
    Math.floor(Math.random() * max),
  );
});

describe('Pairing', () => {
  it('mints a zero-padded code of the configured length', () => {
    const pairing = new Pairing();
    const code = pairing.currentCode();
    expect(code).toMatch(new RegExp(`^\\d{${PAIRING_CODE_LENGTH}}$`));
  });

  it('returns the same code on repeated reads within the TTL', () => {
    const { clock } = makeClock();
    const pairing = new Pairing({ clock });
    expect(pairing.currentCode()).toBe(pairing.currentCode());
  });

  it('mints a new code once the TTL has passed', () => {
    randomIntMock.mockReturnValueOnce(111111).mockReturnValueOnce(222222);
    const { clock, advance } = makeClock();
    const pairing = new Pairing({ clock });

    expect(pairing.currentCode()).toBe('111111');
    advance(PAIRING_CODE_TTL_MS);
    expect(pairing.currentCode()).toBe('222222');
  });

  it('rotate forces a new code even within the TTL', () => {
    randomIntMock.mockReturnValueOnce(111111).mockReturnValueOnce(222222);
    const pairing = new Pairing();

    expect(pairing.currentCode()).toBe('111111');
    expect(pairing.rotate()).toBe('222222');
    expect(pairing.currentCode()).toBe('222222');
  });

  it('accepts the live code and rejects a wrong one', () => {
    const pairing = new Pairing();
    const code = pairing.currentCode();

    const wrongResult = pairing.verify(wrongCodeFor(code), '10.0.0.5');
    expect(wrongResult.outcome).toBe('incorrect');

    // Re-fetch: a wrong attempt must not itself rotate the code.
    const stillCode = pairing.currentCode();
    const result = pairing.verify(stillCode, '10.0.0.5');
    expect(result.outcome).toBe('accepted');
  });

  it('rotates the code on a successful pairing so it cannot pair a second device', () => {
    randomIntMock.mockReturnValueOnce(111111).mockReturnValueOnce(222222);
    const pairing = new Pairing();

    const code = pairing.currentCode();
    expect(pairing.verify(code, '10.0.0.5').outcome).toBe('accepted');
    expect(pairing.verify(code, '10.0.0.6').outcome).toBe('incorrect');
  });

  it('locks an address out after the maximum wrong attempts', () => {
    const { clock } = makeClock();
    const pairing = new Pairing({ clock });
    const code = pairing.currentCode();
    const wrong = wrongCodeFor(code);

    let lastResult;
    for (let i = 0; i < PAIRING_MAX_ATTEMPTS; i += 1) {
      lastResult = pairing.verify(wrong, '10.0.0.9');
    }

    expect(lastResult?.outcome).toBe('locked');
  });

  it('refuses even a correct code while the address is locked out', () => {
    const { clock } = makeClock();
    const pairing = new Pairing({ clock });
    const code = pairing.currentCode();
    const wrong = wrongCodeFor(code);

    for (let i = 0; i < PAIRING_MAX_ATTEMPTS; i += 1) {
      pairing.verify(wrong, '10.0.0.9');
    }

    const result = pairing.verify(code, '10.0.0.9');
    expect(result.outcome).toBe('locked');
  });

  it('lets a locked address back in once the lockout window passes', () => {
    const { clock, advance } = makeClock();
    const pairing = new Pairing({ clock });
    const code = pairing.currentCode();
    const wrong = wrongCodeFor(code);

    for (let i = 0; i < PAIRING_MAX_ATTEMPTS; i += 1) {
      pairing.verify(wrong, '10.0.0.9');
    }
    advance(PAIRING_LOCKOUT_MS);

    const result = pairing.verify(pairing.currentCode(), '10.0.0.9');
    expect(result.outcome).toBe('accepted');
  });

  it('keeps attempt counts separate per remote address', () => {
    const { clock } = makeClock();
    const pairing = new Pairing({ clock });
    const wrong = wrongCodeFor(pairing.currentCode());

    // The first address is locked out COMPLETELY. Stopping one short of the
    // cap — as this test first did — arms no lockout under any keying, so it
    // passed just as well with a single shared counter: the neighbour was
    // only ever being asked whether nothing had happened yet.
    for (let i = 0; i < PAIRING_MAX_ATTEMPTS; i += 1) {
      pairing.verify(wrong, '10.0.0.1');
    }
    expect(pairing.verify(pairing.currentCode(), '10.0.0.1').outcome).toBe(
      'locked',
    );

    // The neighbour is asked with a WRONG code, so what is under test is the
    // COUNTER rather than the code: a shared one would answer `locked` here.
    expect(
      pairing.verify(wrongCodeFor(pairing.currentCode()), '10.0.0.2'),
    ).toEqual({
      outcome: 'incorrect',
      attemptsRemaining: PAIRING_MAX_ATTEMPTS - 1,
    });
  });

  it('clears the attempt counter for an address on success', () => {
    const { clock } = makeClock();
    const pairing = new Pairing({ clock });
    const codeBeforeFirstPairing = pairing.currentCode();
    const wrong = wrongCodeFor(codeBeforeFirstPairing);

    pairing.verify(wrong, '10.0.0.1');
    expect(pairing.verify(pairing.currentCode(), '10.0.0.1').outcome).toBe(
      'accepted',
    );

    // The counter was cleared, so this address can fail the full allowance
    // again before being locked.
    const nextCode = pairing.currentCode();
    const nextWrong = wrongCodeFor(nextCode);
    let lastResult;
    for (let i = 0; i < PAIRING_MAX_ATTEMPTS; i += 1) {
      lastResult = pairing.verify(nextWrong, '10.0.0.1');
    }
    expect(lastResult?.outcome).toBe('locked');
  });

  it('mints a 256-bit hex session token', () => {
    const pairing = new Pairing();
    const token = pairing.mintSessionToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('mints distinct session tokens', () => {
    const pairing = new Pairing();
    expect(pairing.mintSessionToken()).not.toBe(pairing.mintSessionToken());
  });

  // The per-address lockout is not a bound on its own: picking a new source
  // address is free on a LAN, so without a global ceiling a six-digit code is
  // brute-forceable by an attacker who simply keeps changing IP.
  it('locks pairing for everyone once the global attempt ceiling is reached', () => {
    const { clock } = makeClock();
    const pairing = new Pairing({ clock });
    const wrong = wrongCodeFor(pairing.currentCode());

    for (
      let attempt = 0;
      attempt < PAIRING_MAX_GLOBAL_ATTEMPTS - 1;
      attempt += 1
    ) {
      pairing.verify(wrong, `10.0.0.${attempt}`);
    }
    // Every attempt so far came from a different address, so no per-address
    // lockout has fired — this is purely the global ceiling.
    expect(pairing.verify(wrong, '10.0.1.1')).toEqual({
      outcome: 'locked',
      retryAfterMs: PAIRING_LOCKOUT_MS,
    });
    // A brand-new address is refused too, which is the bypass being closed.
    expect(pairing.verify(wrong, '10.0.2.2').outcome).toBe('locked');
  });

  it('rotates the code when the global ceiling trips, so the guessed value stops existing', () => {
    const { clock } = makeClock();
    const pairing = new Pairing({ clock });
    const original = pairing.currentCode();
    const wrong = wrongCodeFor(original);

    for (let attempt = 0; attempt < PAIRING_MAX_GLOBAL_ATTEMPTS; attempt += 1) {
      pairing.verify(wrong, `10.0.0.${attempt}`);
    }

    expect(pairing.currentCode()).not.toBe(original);
  });

  it('lets pairing resume once the global lockout window passes', () => {
    const { clock, advance } = makeClock();
    const pairing = new Pairing({ clock });
    const wrong = wrongCodeFor(pairing.currentCode());

    for (let attempt = 0; attempt < PAIRING_MAX_GLOBAL_ATTEMPTS; attempt += 1) {
      pairing.verify(wrong, `10.0.0.${attempt}`);
    }
    advance(PAIRING_LOCKOUT_MS + 1);

    expect(pairing.verify(pairing.currentCode(), '10.0.3.3')).toEqual({
      outcome: 'accepted',
    });
  });

  it('a successful pairing clears the global counter', () => {
    const { clock } = makeClock();
    const pairing = new Pairing({ clock });
    const wrong = wrongCodeFor(pairing.currentCode());

    for (
      let attempt = 0;
      attempt < PAIRING_MAX_GLOBAL_ATTEMPTS - 1;
      attempt += 1
    ) {
      pairing.verify(wrong, `10.0.0.${attempt}`);
    }
    expect(pairing.verify(pairing.currentCode(), '10.0.9.9').outcome).toBe(
      'accepted',
    );

    // Had the counter survived the success, this single wrong code would trip
    // the ceiling instead of costing one ordinary attempt.
    expect(
      pairing.verify(wrongCodeFor(pairing.currentCode()), '10.0.9.9'),
    ).toEqual({
      outcome: 'incorrect',
      attemptsRemaining: PAIRING_MAX_ATTEMPTS - 1,
    });
  });

  it('forgets the oldest address once the attempt table is full', () => {
    const { clock } = makeClock();
    const pairing = new Pairing({ clock });
    // A success clears the succeeding address's row AND the global counter,
    // so this keeps the ceiling — pinned separately above — out of the way
    // without reaching into the object under test.
    const clearGlobalCounter = (): void => {
      pairing.verify(pairing.currentCode(), 'counter-reset');
    };

    const victim = '10.9.9.9';
    for (let i = 0; i < PAIRING_MAX_ATTEMPTS; i += 1) {
      pairing.verify(wrongCodeFor(pairing.currentCode()), victim);
      clearGlobalCounter();
    }
    expect(pairing.verify(pairing.currentCode(), victim).outcome).toBe(
      'locked',
    );

    // The victim was tracked first, so it is the first row evicted as the
    // table fills with other addresses.
    for (let i = 0; i < PAIRING_MAX_TRACKED_ADDRESSES; i += 1) {
      pairing.verify(
        wrongCodeFor(pairing.currentCode()),
        `10.1.${(i >> 8) & 0xff}.${i & 0xff}`,
      );
      clearGlobalCounter();
    }

    // Its row is gone, and its lockout went with it — which is the eviction
    // being observed from outside rather than counted from inside.
    expect(pairing.verify(pairing.currentCode(), victim).outcome).toBe(
      'accepted',
    );
  });
});
