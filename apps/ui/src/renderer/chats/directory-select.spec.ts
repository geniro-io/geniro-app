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
});
