import { describe, expect, it } from 'vitest';

import { buildPortableArtifact } from './portable-artifact';

const PAGE =
  '<!DOCTYPE html><html><head><style>p{color:red}</style></head><body><a href="https://example.com">x</a></body></html>';

describe('buildPortableArtifact', () => {
  it('bakes the pressed theme into the page, ahead of the page’s own styles', () => {
    const out = buildPortableArtifact(PAGE, {
      '--geniro-fg': '#eeeeee',
      '--geniro-bg': '#111111',
    });

    expect(out).toContain('--geniro-fg: #eeeeee;');
    expect(out).toContain('--geniro-bg: #111111;');
    expect(out.indexOf('data-geniro="theme"')).toBeLessThan(
      out.indexOf('p{color:red}'),
    );
  });

  it('drops a theme value that could close its <style>', () => {
    const out = buildPortableArtifact(PAGE, {
      '--geniro-fg': 'red</style><script>alert(1)</script>',
    });

    expect(out).not.toContain('alert(1)');
  });

  it('drops a theme value that could close the :root block', () => {
    const out = buildPortableArtifact(PAGE, {
      '--geniro-fg': 'red } body { display: none',
    });

    expect(out).not.toContain('display: none');
  });

  it('falls back to the runtime’s light ground when no theme was handed over', () => {
    const out = buildPortableArtifact(PAGE, null);

    expect(out).toMatch(/background: var\(--geniro-bg, #[0-9a-f]+\)/i);
  });

  it('opens the page’s links in a new tab, the one place a framed reader can follow them', () => {
    expect(buildPortableArtifact(PAGE, null)).toContain(
      '<base target="_blank">',
    );
  });
});
