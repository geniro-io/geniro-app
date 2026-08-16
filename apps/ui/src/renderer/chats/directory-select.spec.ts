import { describe, expect, it } from 'vitest';

import { folderName, shortenPath } from './directory-select';

describe('folderName', () => {
  it('takes the trailing segment', () => {
    expect(folderName('/Users/me/Projects/geniro-app')).toBe('geniro-app');
  });

  it('ignores a trailing slash', () => {
    expect(folderName('/Users/me/Projects/geniro-app/')).toBe('geniro-app');
  });
});

describe('shortenPath', () => {
  it('elides the HEAD of a long path, never the tail', () => {
    // The tail is the only identifying part; a right-truncated
    // "/var/folders/rr/dcr7_c0x1037…" names nothing.
    expect(shortenPath('/var/folders/rr/dcr7_c0x1037/T/wf-demo')).toBe(
      '…/dcr7_c0x1037/T/wf-demo',
    );
  });

  it('leaves a short path whole', () => {
    expect(shortenPath('/Users/me/proj')).toBe('/Users/me/proj');
  });

  it('keeps enough tail to tell two checkouts of one repo apart', () => {
    const a = shortenPath('/Users/me/work/alpha/geniro-app');
    const b = shortenPath('/Users/me/work/beta/geniro-app');
    expect(a).not.toBe(b);
  });

  it('takes a caller’s own tail length, and still MARKS the elision', () => {
    // The context panel asks for two, because three CLAUDE.md rows are told
    // apart by their parent alone. The copy it used to keep returned
    // `project/CLAUDE.md` with no marker, so a shortened path was
    // indistinguishable from a genuinely short one — that leading `…` is the
    // half the merge is for.
    expect(shortenPath('/Users/me/project/CLAUDE.md', 2)).toBe(
      '…/project/CLAUDE.md',
    );
  });

  it('leaves a path already within the caller’s length whole', () => {
    // Both sides of the `<=`, and with a path the DEFAULT would treat
    // differently: `/proj/CLAUDE.md` is 2 segments, so it comes back whole
    // under `segments = 2` and under the default 3 alike — an argument the
    // function ignored entirely would pass on it.
    expect(shortenPath('/proj/CLAUDE.md', 2)).toBe('/proj/CLAUDE.md');
    expect(shortenPath('/a/proj/CLAUDE.md', 2)).toBe('…/proj/CLAUDE.md');
    expect(shortenPath('/a/proj/CLAUDE.md')).toBe('/a/proj/CLAUDE.md');
  });
});
