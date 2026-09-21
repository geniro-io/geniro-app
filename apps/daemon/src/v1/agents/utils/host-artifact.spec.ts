import { describe, expect, it } from 'vitest';

import {
  MAX_ARTIFACT_ID_LENGTH,
  MAX_ARTIFACT_TITLE_LENGTH,
} from '../chat.types';
import {
  hostArtifactResultText,
  isHostArtifactCall,
  readHostArtifact,
} from './host-artifact';

const PAGE = '<!doctype html><title>x</title><p>hello';

describe('isHostArtifactCall', () => {
  const SERVER = 'geniro-ab12cd34';

  it('names the artifact tool on geniro’s own run-scoped server', () => {
    expect(isHostArtifactCall(SERVER, `mcp__${SERVER}__show_artifact`)).toBe(
      true,
    );
  });

  it('matches cursor’s prose label, which pairs the two names', () => {
    expect(isHostArtifactCall(SERVER, `${SERVER} show_artifact`)).toBe(true);
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

describe('readHostArtifact', () => {
  it('reads a title and a document', () => {
    expect(readHostArtifact({ title: 'Migration plan', html: PAGE })).toEqual({
      title: 'Migration plan',
      html: PAGE,
    });
  });

  it('accepts `content` as a synonym for `html`', () => {
    expect(readHostArtifact({ title: 'x', content: PAGE })?.html).toBe(PAGE);
  });

  it('refuses a document with no title — a rail row needs a heading', () => {
    expect(readHostArtifact({ html: PAGE })).toBeNull();
  });

  it('refuses a title with no document', () => {
    expect(readHostArtifact({ title: 'Just a name' })).toBeNull();
  });

  it('refuses a document that is only whitespace', () => {
    expect(readHostArtifact({ title: 'x', html: '   \n  ' })).toBeNull();
  });

  it('keeps the document WHOLE rather than trimming it to a cap', () => {
    // The byte ceiling refuses rather than truncates, so nothing here may cut a
    // document short: half an HTML file renders as its own broken source. This
    // fails if a `.slice(...)` is ever added to the html path.
    const long = `${PAGE}${'<p>x</p>'.repeat(50_000)}`;
    expect(readHostArtifact({ title: 'x', html: long })?.html).toBe(long);
  });

  it('strips the blank lines a model wraps a document in', () => {
    expect(
      readHostArtifact({ title: 'x', html: `\n\n${PAGE}\n\n` })?.html,
    ).toBe(PAGE);
  });

  describe('artifact_id', () => {
    it('is absent when the caller named none, so the store mints one', () => {
      expect(readHostArtifact({ title: 'x', html: PAGE })).not.toHaveProperty(
        'id',
      );
    });

    it('passes a slug through unchanged', () => {
      expect(
        readHostArtifact({ title: 'x', html: PAGE, artifact_id: 'plan-v2' })
          ?.id,
      ).toBe('plan-v2');
    });

    it('normalizes the near-misses a model actually writes', () => {
      for (const written of [
        'Migration Plan',
        'migration_plan',
        '  migration plan  ',
      ]) {
        expect(
          readHostArtifact({ title: 'x', html: PAGE, artifact_id: written })
            ?.id,
        ).toBe('migration-plan');
      }
    });

    it('normalizes stably, which is what makes a revision land on the same page', () => {
      const once = readHostArtifact({
        title: 'x',
        html: PAGE,
        artifact_id: 'My Plan!',
      })?.id;
      const twice = readHostArtifact({
        title: 'x',
        html: PAGE,
        artifact_id: 'My Plan!',
      })?.id;
      expect(once).toBe(twice);
      expect(once).toBe('my-plan');
    });

    it('accepts `id` as a synonym', () => {
      expect(readHostArtifact({ title: 'x', html: PAGE, id: 'plan' })?.id).toBe(
        'plan',
      );
    });

    it('cannot produce a path separator or a traversal segment', () => {
      for (const hostile of ['../../etc/passwd', 'a/b', '..', './x', 'C:\\x']) {
        const id = readHostArtifact({
          title: 'x',
          html: PAGE,
          artifact_id: hostile,
        })?.id;
        expect(id === undefined || /^[a-z0-9][a-z0-9-]*$/.test(id)).toBe(true);
        expect(id ?? '').not.toContain('/');
        expect(id ?? '').not.toContain('\\');
        expect(id).not.toBe('..');
      }
    });

    it('drops an id that normalizes to nothing rather than inventing one', () => {
      expect(
        readHostArtifact({ title: 'x', html: PAGE, artifact_id: '!!!' }),
      ).not.toHaveProperty('id');
    });

    it('caps the length, and never ends on the separator the slice exposes', () => {
      const id = readHostArtifact({
        title: 'x',
        html: PAGE,
        artifact_id: `${'a'.repeat(MAX_ARTIFACT_ID_LENGTH)} tail`,
      })?.id;
      expect(id).toBe('a'.repeat(MAX_ARTIFACT_ID_LENGTH));
      expect(id?.endsWith('-')).toBe(false);
    });
  });

  it('caps the title', () => {
    const title = readHostArtifact({
      title: 'T'.repeat(MAX_ARTIFACT_TITLE_LENGTH + 40),
      html: PAGE,
    })?.title;
    expect(title).toHaveLength(MAX_ARTIFACT_TITLE_LENGTH);
  });

  it('leaves an absent summary absent rather than inventing one', () => {
    expect(readHostArtifact({ title: 'x', html: PAGE })).not.toHaveProperty(
      'summary',
    );
  });

  it('does not throw on any shape a model could send', () => {
    for (const args of [
      {},
      { title: 5, html: 7 },
      { title: null, html: [] },
      { html: { nested: true }, title: 'x' },
      { title: 'x', html: PAGE, artifact_id: 42 },
      { title: 'x', html: PAGE, summary: {} },
    ] as Record<string, unknown>[]) {
      expect(() => readHostArtifact(args)).not.toThrow();
    }
  });
});

describe('hostArtifactResultText', () => {
  it('teaches the agent the id it must reuse to revise a first publish', () => {
    const text = hostArtifactResultText({
      status: 'published',
      artifactId: 'plan',
      version: 1,
    });
    expect(text).toContain('plan');
    expect(text).toContain('revise');
  });

  it('states the version on a revision, so a silent no-op is visible', () => {
    expect(
      hostArtifactResultText({
        status: 'published',
        artifactId: 'plan',
        version: 4,
      }),
    ).toContain('version 4');
  });

  it('carries the reason a publish was refused', () => {
    expect(
      hostArtifactResultText({
        status: 'rejected',
        reason: 'the page is over the 512KB limit',
      }),
    ).toContain('512KB');
  });

  it('tells an agent with no panel to fall back to its reply', () => {
    const text = hostArtifactResultText({
      status: 'unavailable',
      reason: 'no turn is running that could show it',
    });
    expect(text).toContain('no turn is running that could show it');
    expect(text).toContain('reply');
  });

  it('never echoes the document back into the model’s window', () => {
    // The whole point of a host-drawn page is that it does not re-enter the
    // conversation. This goes red if a receipt is ever built from the html.
    for (const outcome of [
      { status: 'published', artifactId: 'plan', version: 1 },
      { status: 'published', artifactId: 'plan', version: 2 },
      { status: 'rejected', reason: 'too large' },
      { status: 'unavailable', reason: 'nowhere to draw' },
    ] as const) {
      expect(hostArtifactResultText(outcome)).not.toContain('<');
    }
  });
});
