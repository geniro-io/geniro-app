import type { FastifyReply } from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import type { ArtifactPageService } from '../services/artifact-page.service';
import { ARTIFACT_PAGE_CSP } from '../utils/artifact-page';
import { ArtifactsController } from './artifacts.controller';

/** What the controller wrote, in the order it wrote it. */
interface Written {
  code: number | null;
  type: string | null;
  headers: Record<string, string>;
  removed: string[];
  body: string | null;
}

function setup(page: string | null): {
  controller: ArtifactsController;
  reply: FastifyReply;
  written: Written;
  pageFor: ReturnType<typeof vi.fn>;
} {
  const written: Written = {
    code: null,
    type: null,
    headers: {},
    removed: [],
    body: null,
  };
  // Chainable, like the real `FastifyReply` — the controller composes its
  // response as one chain, so a double that does not return itself would fail
  // for a reason that has nothing to do with the behaviour under test.
  const reply = {
    code(value: number) {
      written.code = value;
      return this;
    },
    type(value: string) {
      written.type = value;
      return this;
    },
    header(name: string, value: string) {
      written.headers[name] = value;
      return this;
    },
    // The RAW Node response, because that is where the express `helmet`
    // middleware sets the headers this route has to clear.
    raw: {
      removeHeader(name: string) {
        written.removed.push(name);
      },
    },
    send(value: string) {
      written.body = value;
      return this;
    },
  } as unknown as FastifyReply;
  const pageFor = vi.fn(() => page);
  const controller = new ArtifactsController({
    page: pageFor,
  } as unknown as ArtifactPageService);
  return { controller, reply, written, pageFor };
}

const KEY = 'k'.repeat(64);

describe('ArtifactsController', () => {
  it('serves the page with 200 and an HTML content type', () => {
    const { controller, reply, written } = setup('<p>the page</p>');

    controller.page('run-1', 'plan', KEY, '2', reply);

    expect(written.code).toBe(200);
    expect(written.body).toBe('<p>the page</p>');
    expect(written.headers['content-type']).toBe('text/html; charset=utf-8');
  });

  it('carries the page’s OWN Content-Security-Policy', () => {
    // The whole of what makes agent-authored script safe to run: the framed
    // document does not inherit the embedder's policy, so this header is the
    // only thing giving it `default-src 'none'`. Deleting the `.header(...)`
    // call reddens here and nowhere else — nothing in this daemon boots the
    // HTTP app, so no other spec can observe a response header.
    const { controller, reply, written } = setup('<p>x</p>');

    controller.page('run-1', 'plan', KEY, '1', reply);

    expect(written.headers['content-security-policy']).toBe(ARTIFACT_PAGE_CSP);
  });

  it('refuses content sniffing on a document an agent wrote', () => {
    const { controller, reply, written } = setup('<p>x</p>');

    controller.page('run-1', 'plan', KEY, '1', reply);

    expect(written.headers['x-content-type-options']).toBe('nosniff');
  });

  it('clears the framing headers helmet sets for every other route', () => {
    // MEASURED against the running app: the route answered 200 with the right
    // body and the frame rendered BLANK, because helmet's global
    // `X-Frame-Options: SAMEORIGIN` and `Cross-Origin-Resource-Policy:
    // same-origin` refuse an embed from the renderer — which is a `file:`
    // document in a packaged build and a dev-server URL under `pnpm dev`, so
    // cross-origin to the daemon either way. Nothing else in the suite can see
    // this: the headers come from middleware, not from the controller.
    const { controller, reply, written } = setup('<p>x</p>');

    controller.page('run-1', 'plan', KEY, '1', reply);

    // Cleared on the RAW response: the express `helmet` middleware sets it
    // with `res.setHeader`, which Fastify's own `removeHeader` cannot reach —
    // measured on the wire before this was corrected.
    expect(written.removed).toContain('X-Frame-Options');
    expect(written.headers['cross-origin-resource-policy']).toBe(
      'cross-origin',
    );
  });

  it('does not let the page be cached', () => {
    const { controller, reply, written } = setup('<p>x</p>');

    controller.page('run-1', 'plan', KEY, '1', reply);

    expect(written.headers['cache-control']).toBe('no-store');
  });

  it('asks the service for the version the query names', () => {
    const { controller, reply, pageFor } = setup('<p>x</p>');

    controller.page('run-1', 'plan', KEY, '4', reply);

    expect(pageFor).toHaveBeenCalledWith('run-1', 'plan', 4, KEY);
  });

  it('reads an omitted version as the first one', () => {
    const { controller, reply, pageFor } = setup('<p>x</p>');

    controller.page('run-1', 'plan', KEY, undefined, reply);

    expect(pageFor).toHaveBeenCalledWith('run-1', 'plan', 1, KEY);
  });

  it('passes an omitted key through as empty rather than as undefined', () => {
    // The store takes the key as a required argument and compares it in
    // constant time; handing it `undefined` would be a different code path
    // than the one that refuses a wrong key.
    const { controller, reply, pageFor } = setup(null);

    controller.page('run-1', 'plan', undefined, '1', reply);

    expect(pageFor).toHaveBeenCalledWith('run-1', 'plan', 1, '');
  });

  describe('when the page cannot be served', () => {
    it('answers 404 with a plain-text body and no page bytes', () => {
      const { controller, reply, written } = setup(null);

      controller.page('run-1', 'plan', 'wrong', '1', reply);

      expect(written.code).toBe(404);
      expect(written.type).toBe('text/plain; charset=utf-8');
      expect(written.body).toBe('not found');
    });

    it('sends ONE identical answer whatever the reason', () => {
      // The non-enumeration property this route rests on: the caller is
      // unauthenticated, so a wrong key and an artifact that does not exist
      // must be indistinguishable. The store already answers one null for
      // both; this is the route not undoing that.
      const wrongKey = setup(null);
      wrongKey.controller.page('run-1', 'plan', 'wrong', '1', wrongKey.reply);

      const noSuchArtifact = setup(null);
      noSuchArtifact.controller.page(
        'run-1',
        'nothing-here',
        KEY,
        '1',
        noSuchArtifact.reply,
      );

      expect(wrongKey.written).toEqual(noSuchArtifact.written);
    });

    it('writes no CSP header on the refusal — there is no page to police', () => {
      const { controller, reply, written } = setup(null);

      controller.page('run-1', 'plan', 'wrong', '1', reply);

      expect(written.headers).toEqual({});
    });
  });
});
