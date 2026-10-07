import { describe, expect, it } from 'vitest';

import {
  codexContextWindowListing,
  codexWindowLabel,
  codexWindowTokens,
  readCodexModelWindows,
} from './codex-context-windows.utils';

describe('codex context windows', () => {
  it('names a window the way it is stored, and reads it back', () => {
    expect(codexWindowLabel(272_000)).toBe('272k');
    expect(codexWindowLabel(1_000_000)).toBe('1m');
    expect(codexWindowTokens('872k')).toBe(872_000);
    expect(codexWindowTokens('1m')).toBe(1_000_000);
    expect(codexWindowTokens('500000')).toBe(500_000);
    expect(codexWindowTokens('')).toBeNull();
    expect(codexWindowTokens('max')).toBeNull();
  });

  it('reads a model’s windows out of the catalog, and nothing for a partial entry', () => {
    const catalog = {
      models: [
        { slug: 'a', context_window: 272000, max_context_window: 872000 },
        { slug: 'b', context_window: 272000 },
      ],
    };
    expect(readCodexModelWindows(catalog, 'a')).toEqual({
      defaultTokens: 272_000,
      maxTokens: 872_000,
    });
    expect(readCodexModelWindows(catalog, 'b')).toBeNull();
    expect(readCodexModelWindows(catalog, 'missing')).toBeNull();
    expect(readCodexModelWindows('not json', 'a')).toBeNull();
  });

  it('asks for a model before offering anything', () => {
    expect(codexContextWindowListing(null, null).unavailableKind).toBe(
      'no-model',
    );
  });
});
