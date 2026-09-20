// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

import {
  ARTIFACT_FRAME_SOURCE,
  ARTIFACT_HOST_SOURCE,
  ARTIFACT_PAGE_CSP,
  renderArtifactPage,
} from './artifact-page';

describe('ARTIFACT_PAGE_CSP', () => {
  const directive = (name: string): string | undefined =>
    ARTIFACT_PAGE_CSP.split('; ').find((part) => part.startsWith(`${name} `));

  it('denies everything by default, which is what makes the page safe to run', () => {
    expect(directive('default-src')).toBe("default-src 'none'");
  });

  it('gives the page NO network of any kind', () => {
    // The load-bearing claim of the whole feature: agent script runs, and it
    // can reach nothing. `default-src 'none'` covers connect/frame/worker/
    // object, and none of them may be re-opened by a directive of its own.
    for (const opened of [
      'connect-src',
      'frame-src',
      'worker-src',
      'object-src',
      'child-src',
      'manifest-src',
      'prefetch-src',
    ]) {
      expect(directive(opened), `${opened} re-opened`).toBeUndefined();
    }
    expect(ARTIFACT_PAGE_CSP).not.toContain('http');
    expect(ARTIFACT_PAGE_CSP).not.toContain('*');
  });

  it('allows the inline style and script the format is made of', () => {
    expect(directive('script-src')).toBe("script-src 'unsafe-inline'");
    expect(directive('style-src')).toBe("style-src 'unsafe-inline'");
  });

  it('does not allow eval, which nothing in a static page needs', () => {
    expect(ARTIFACT_PAGE_CSP).not.toContain('unsafe-eval');
  });

  it('allows only inline data for the media a page draws with', () => {
    expect(directive('img-src')).toBe('img-src data:');
    expect(directive('font-src')).toBe('font-src data:');
    expect(directive('media-src')).toBe('media-src data:');
  });

  it('pins base-uri and form-action, which default-src does NOT cover', () => {
    // Without the first a <base> tag re-points every relative URL in the
    // document; without the second a form can POST the page's contents even
    // though script cannot reach the network.
    expect(directive('base-uri')).toBe("base-uri 'none'");
    expect(directive('form-action')).toBe("form-action 'none'");
  });
});

describe('renderArtifactPage', () => {
  it('passes the agent’s document through untouched', () => {
    // Not parsed, not sanitized, not rewritten — the sandbox is what makes the
    // contents moot, and a rewrite would break pages for no security gain.
    const html =
      '<!doctype html><html><head><style>b{color:red}</style></head><body><p onclick="go()">hi</p><script>var x=1<2;</script></body></html>';
    const page = renderArtifactPage(html);
    expect(page).toContain('<p onclick="go()">hi</p>');
    expect(page).toContain('var x=1<2;');
    expect(page).toContain('b{color:red}');
  });

  it('puts geniro’s block INSIDE the body, before its close', () => {
    const page = renderArtifactPage('<body><p>hi</p></body>');
    expect(page.indexOf(ARTIFACT_FRAME_SOURCE)).toBeLessThan(
      page.indexOf('</body>'),
    );
  });

  it('still wraps a bare FRAGMENT, which is what a model usually sends', () => {
    const page = renderArtifactPage('<h1>Plan</h1><p>step one</p>');
    expect(page).toContain('<h1>Plan</h1>');
    expect(page).toContain(ARTIFACT_FRAME_SOURCE);
  });

  it.each([
    ['</body>', '</body>'],
    ['</BODY>', '</BODY>'],
    ['</body >', '</body >'],
  ])(
    'matches %s whatever case or spacing it was written in',
    (_name, close) => {
      // Asserted against the index of the literal close tag. An earlier version
      // compared against `lastIndexOf('</')`, which lands on the block's own
      // appended `</script>` and so held whether the tag matched or not.
      const page = renderArtifactPage(`<body><p>hi</p>${close}`);
      expect(page.indexOf(ARTIFACT_FRAME_SOURCE)).toBeLessThan(
        page.indexOf(close),
      );
    },
  );

  it('splices at the LAST </body>, not an earlier one inside the page’s own script', () => {
    // A page that emits markup from its own script contains the tag before the
    // real one. Splicing there ends that script element on the block's own
    // closing tag and breaks the page, taking the wrapper with it.
    const html =
      '<body><script>var t = "<p>x</p></body>";</script><p>real</p></body>';
    const page = renderArtifactPage(html);

    // The decoy inside the string literal is untouched…
    expect(page).toContain('var t = "<p>x</p></body>";');
    // …and the block lands after the page's own script, before the real close.
    expect(page.indexOf(ARTIFACT_FRAME_SOURCE)).toBeGreaterThan(
      page.indexOf('var t ='),
    );
    expect(page.indexOf(ARTIFACT_FRAME_SOURCE)).toBeLessThan(
      page.lastIndexOf('</body>'),
    );
  });

  it('does not read a `$` in the agent’s document as a replacement pattern', () => {
    // `String.replace` expands `$&` and `$1` in a string replacement; the
    // block is inserted through a function replacer so it cannot.
    const page = renderArtifactPage('<body><p>cost: $& and $1</p></body>');
    expect(page).toContain('<p>cost: $& and $1</p>');
  });

  it('paints transparent so the app’s own background shows through', () => {
    expect(renderArtifactPage('<p>x</p>')).toContain(
      'html, body { background: transparent; }',
    );
  });

  it('gives every theme token a fallback, so the page reads before any message', () => {
    const page = renderArtifactPage('<p>x</p>');
    for (const token of ['--geniro-fg', '--geniro-font', '--geniro-primary']) {
      expect(page).toMatch(new RegExp(`var\\(${token},[^)]+\\)`));
    }
  });

  it('is idempotent in the only sense that matters — one wrapper per render', () => {
    const page = renderArtifactPage('<body><p>x</p></body>');
    expect(page.split(ARTIFACT_HOST_SOURCE)).toHaveLength(2);
  });
});

/**
 * The injected wrapper, RUN rather than read.
 *
 * Its previous pins were `toContain` over the script's own source, which fail
 * in both directions: a reformatted guard reddens with behaviour unchanged,
 * and a flipped comparison inside it stays green while the frame never grows.
 * These execute the script the page actually carries and observe what it
 * posts and writes.
 */
describe('the injected wrapper script', () => {
  /** The script exactly as `renderArtifactPage` emits it. */
  const wrapperScript = (): string => {
    const page = renderArtifactPage('<p>x</p>');
    const match = /<script>([\s\S]*?)<\/script>/.exec(page);
    if (match?.[1] === undefined) {
      throw new Error('the rendered page carried no wrapper script');
    }
    return match[1];
  };

  /** Messages the script posted to its parent, newest last. */
  let posted: Record<string, unknown>[];
  let listeners: [string, EventListenerOrEventListenerObject][];

  /**
   * Run the wrapper once, recording the listeners it installs so they can be
   * removed again — the document is shared across this file's tests, and a
   * leaked listener would answer the next test's messages too.
   */
  const runWrapper = (): void => {
    const add = window.addEventListener.bind(window);
    window.addEventListener = ((
      type: string,
      handler: EventListenerOrEventListenerObject,
    ) => {
      listeners.push([type, handler]);
      add(type, handler);
    }) as typeof window.addEventListener;
    try {
      new Function(wrapperScript())();
    } finally {
      window.addEventListener = add;
    }
  };

  const sendFromHost = (data: unknown): void => {
    window.dispatchEvent(
      new MessageEvent('message', { data, source: window.parent }),
    );
  };

  /**
   * jsdom delivers `postMessage` on a later task, so anything the script POSTS
   * is unobservable in the turn that triggered it. The theme assertions need
   * no flush — those read a synchronous `setProperty`.
   */
  const flush = (): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, 0));

  afterEach(() => {
    for (const [type, handler] of listeners) {
      window.removeEventListener(type, handler);
    }
    document.documentElement.removeAttribute('style');
  });

  const setup = (bodyHeight = 400): void => {
    posted = [];
    listeners = [];
    // jsdom lays nothing out, so the height the script measures is stubbed.
    Object.defineProperty(document.body, 'scrollHeight', {
      value: bodyHeight,
      configurable: true,
    });
    Object.defineProperty(document.body, 'offsetHeight', {
      value: bodyHeight,
      configurable: true,
    });
    const collect = (event: Event): void => {
      const data: unknown = (event as MessageEvent).data;
      if (
        typeof data === 'object' &&
        data !== null &&
        (data as { source?: unknown }).source === ARTIFACT_FRAME_SOURCE
      ) {
        posted.push(data as Record<string, unknown>);
      }
    };
    window.addEventListener('message', collect);
    listeners = [['message', collect]];
    runWrapper();
  };

  it('announces itself to the host as soon as it runs', async () => {
    // The host answers `ready` with the theme; without it a page opened before
    // the frame's load event would never be themed.
    setup();
    await flush();
    expect(posted.map((m) => m.type)).toContain('ready');
  });

  it('applies the theme values the host sends', () => {
    setup();
    sendFromHost({
      source: ARTIFACT_HOST_SOURCE,
      type: 'theme',
      vars: { '--geniro-fg': 'rgb(1, 2, 3)' },
    });
    expect(document.documentElement.style.getPropertyValue('--geniro-fg')).toBe(
      'rgb(1, 2, 3)',
    );
  });

  it('ignores a message that is not tagged as the host’s', () => {
    setup();
    sendFromHost({
      source: 'something-else',
      type: 'theme',
      vars: { '--geniro-fg': 'red' },
    });
    expect(document.documentElement.style.getPropertyValue('--geniro-fg')).toBe(
      '',
    );
  });

  it('ignores a message that did not come from its own parent', () => {
    setup();
    const foreign = document.createElement('iframe');
    document.body.appendChild(foreign);
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          source: ARTIFACT_HOST_SOURCE,
          type: 'theme',
          vars: { '--geniro-fg': 'red' },
        },
        source: foreign.contentWindow,
      }),
    );
    expect(document.documentElement.style.getPropertyValue('--geniro-fg')).toBe(
      '',
    );
    foreign.remove();
  });

  it('survives a theme value the document will not take', () => {
    // The try/catch around `setProperty` — a defensive branch worth a test
    // that enters it. One bad token must not stop the rest being applied.
    setup();
    sendFromHost({
      source: ARTIFACT_HOST_SOURCE,
      type: 'theme',
      vars: { 'not a custom property': 'x', '--geniro-fg': 'rgb(9, 9, 9)' },
    });
    expect(document.documentElement.style.getPropertyValue('--geniro-fg')).toBe(
      'rgb(9, 9, 9)',
    );
  });

  it('reports the height it measures', async () => {
    setup(400);
    sendFromHost({ source: ARTIFACT_HOST_SOURCE, type: 'theme', vars: {} });
    await flush();
    const heights = posted
      .filter((m) => m.type === 'height')
      .map((m) => m.height);
    expect(heights).toContain(400);
  });

  it('does NOT re-post a height that has not changed', async () => {
    // The dedupe. Its absence floods the host with a message per frame; its
    // INVERSION (`!==`) posts nothing at all and the frame never grows past
    // its initial height — and neither is visible in the script's source.
    setup(400);
    sendFromHost({ source: ARTIFACT_HOST_SOURCE, type: 'theme', vars: {} });
    await flush();
    const before = posted.filter((m) => m.type === 'height').length;
    expect(before).toBeGreaterThan(0);

    sendFromHost({ source: ARTIFACT_HOST_SOURCE, type: 'theme', vars: {} });
    sendFromHost({ source: ARTIFACT_HOST_SOURCE, type: 'theme', vars: {} });
    await flush();

    // Two further theme messages, the measured height unchanged: nothing more
    // is posted.
    expect(posted.filter((m) => m.type === 'height')).toHaveLength(before);
  });

  it('reports again once the height has actually moved', async () => {
    // The other side of the dedupe — without this the test above is satisfied
    // by a script that reports once and never again.
    setup(400);
    sendFromHost({ source: ARTIFACT_HOST_SOURCE, type: 'theme', vars: {} });
    await flush();

    Object.defineProperty(document.body, 'scrollHeight', {
      value: 900,
      configurable: true,
    });
    Object.defineProperty(document.body, 'offsetHeight', {
      value: 900,
      configurable: true,
    });
    sendFromHost({ source: ARTIFACT_HOST_SOURCE, type: 'theme', vars: {} });
    await flush();

    expect(
      posted.filter((m) => m.type === 'height').map((m) => m.height),
    ).toContain(900);
  });
});
