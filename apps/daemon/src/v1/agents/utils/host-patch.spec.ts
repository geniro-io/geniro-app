import { describe, expect, it } from 'vitest';

import { HOST_PATCH_TOOL } from '../chat.types';
import { isHostPatchCall } from './host-patch';

const SERVER = 'geniro-1a2b3c4d';

describe('isHostPatchCall', () => {
  it('matches both CLIs’ spellings of this run’s server', () => {
    expect(isHostPatchCall(SERVER, `mcp__${SERVER}__${HOST_PATCH_TOOL}`)).toBe(
      true,
    );
    expect(
      isHostPatchCall(
        SERVER,
        `${SERVER}-${HOST_PATCH_TOOL}: ${HOST_PATCH_TOOL}`,
      ),
    ).toBe(true);
  });

  it('refuses somebody else’s tool of the same name', () => {
    expect(isHostPatchCall(SERVER, 'mcp__acme__propose_patch')).toBe(false);
    expect(isHostPatchCall(null, `mcp__${SERVER}__${HOST_PATCH_TOOL}`)).toBe(
      false,
    );
  });
});
