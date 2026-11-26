import { describe, expect, it } from 'vitest';

import { NearDuplicateError } from '../components/use-memory-editor';
import { described } from './lessons-api-context';

describe('described', () => {
  it('keeps the handles a near-duplicate refusal names', async () => {
    const refused = described(
      Promise.reject(
        new Error(
          'daemon POST /v1/lessons/lp-1/update-rule failed (409): {"code":"MEMORY_NEAR_DUPLICATE","message":"similar entries exist: m1106, m7"}',
        ),
      ),
    );

    await expect(refused).rejects.toBeInstanceOf(NearDuplicateError);
    await expect(refused).rejects.toMatchObject({ handles: ['m1106', 'm7'] });
  });

  it("passes any other refusal on as the daemon's sentence", async () => {
    const refused = described(
      Promise.reject(
        new Error(
          'daemon POST /v1/lessons/lp-1/save failed (409): {"code":"LESSON_DECIDED","message":"this lesson is decided already"}',
        ),
      ),
    );

    await expect(refused).rejects.not.toBeInstanceOf(NearDuplicateError);
    await expect(refused).rejects.toThrow('this lesson is decided already');
  });
});
