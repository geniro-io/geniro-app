import { expect } from 'vitest';

import type { CallEnvelope } from '../graphs.types';

/**
 * Assert an envelope is the ERROR arm, and hand back its message.
 *
 * `CallEnvelope` is a discriminated union: `error` exists on one arm only. A
 * bare `expect(env.status).toBe('error')` proves that to a reader but not to
 * the compiler, so every `env.error` read after it was unchecked — and on an
 * `ok` envelope it silently produced `undefined`, which `toContain` then
 * reports as a confusing "received undefined" instead of "the call succeeded
 * when it should have failed".
 *
 * Narrowing and asserting in one move is what makes the wrong arm fail HERE,
 * naming the status it actually got.
 */
export function errorOf(envelope: CallEnvelope): string {
  expect(envelope.status).toBe('error');
  if (envelope.status !== 'error') {
    throw new Error(
      `expected an error envelope, got status '${envelope.status}'`,
    );
  }
  return envelope.error;
}
