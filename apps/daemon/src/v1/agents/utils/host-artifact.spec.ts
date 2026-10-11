import { describe, expect, it } from 'vitest';

import { isHostArtifactCall } from './host-artifact';

describe('isHostArtifactCall', () => {
  const SERVER = 'geniro-ab12cd34';

  it('names the artifact tool on geniro’s own run-scoped server', () => {
    expect(isHostArtifactCall(SERVER, `mcp__${SERVER}__show_artifact`)).toBe(
      true,
    );
  });

  it('matches cursor’s measured title, `<server>-<tool>: <tool>`', () => {
    expect(
      isHostArtifactCall(SERVER, `${SERVER}-show_artifact: show_artifact`),
    ).toBe(true);
  });

  it('does not claim a same-named tool from another server', () => {
    expect(
      isHostArtifactCall(SERVER, 'mcp__some-other-server__show_artifact'),
    ).toBe(false);
  });

  it('refuses when the turn was granted no such tool', () => {
    expect(isHostArtifactCall(null, `mcp__${SERVER}__show_artifact`)).toBe(
      false,
    );
  });
});
