import { describe, expect, it } from 'vitest';

import { toolKindOf } from './tool-kind';

describe('toolKindOf', () => {
  it('reads the kind the daemon stamped', () => {
    expect(toolKindOf({ name: 'Edit File', toolKind: 'edit' })).toBe('edit');
    expect(toolKindOf({ name: 'grep', toolKind: 'search' })).toBe('search');
  });

  it('is null for a call the CLI did not classify', () => {
    // Every claude row: the payload carries a name and an input and no kind, and
    // must keep going through the name buckets exactly as before.
    expect(toolKindOf({ name: 'Read', input: { file_path: '/a' } })).toBeNull();
    expect(toolKindOf(null)).toBeNull();
    expect(toolKindOf('edit')).toBeNull();
  });

  it('is null for a kind this summary has no phrase for', () => {
    // `think`/`switch_mode`/`other` are real ACP members with nothing to say
    // about them, and a later protocol version may add more. They read as
    // unclassified, which counts them as an unnamed call rather than inventing a
    // bucket — the honest answer for work the summary cannot describe.
    expect(toolKindOf({ toolKind: 'think' })).toBeNull();
    expect(toolKindOf({ toolKind: 'switch_mode' })).toBeNull();
    expect(toolKindOf({ toolKind: 'other' })).toBeNull();
    expect(toolKindOf({ toolKind: 'teleport' })).toBeNull();
  });
});
