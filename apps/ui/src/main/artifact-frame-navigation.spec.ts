import type { WebContents } from 'electron';
import { describe, expect, it } from 'vitest';

import {
  guardArtifactFrameNavigations,
  isAllowedArtifactFrameNavigation,
} from './artifact-frame-navigation';

const DAEMON_ORIGIN = 'http://127.0.0.1:47615';

const ARTIFACT_PAGE = `${DAEMON_ORIGIN}/v1/artifacts/run-1/revenue-plan?key=k3Yw9&v=2`;

const REFUSED = [
  {
    why: 'another site',
    url: 'https://example.com/x',
  },
  {
    why: 'another route on the daemon',
    url: `${DAEMON_ORIGIN}/v1/chats/x`,
  },
  {
    why: 'a route that only shares the artifact prefix',
    url: `${DAEMON_ORIGIN}/v1/artifacts-debug/x`,
  },
  {
    why: 'a path that climbs out of the artifact route',
    url: `${DAEMON_ORIGIN}/v1/artifacts/../chats/x`,
  },
  {
    why: 'the daemon host on another port',
    url: 'http://127.0.0.1:47999/v1/artifacts/x',
  },
  {
    why: 'a host that merely begins like the daemon host',
    url: 'http://127.0.0.1.evil.example/v1/artifacts/x',
  },
  {
    why: 'credentials that spell the daemon origin before another host',
    url: 'http://127.0.0.1:47615@evil.example/v1/artifacts/x',
  },
  {
    why: 'a file',
    url: 'file:///etc/passwd',
  },
  {
    why: 'a javascript URL',
    url: 'javascript:alert(1)',
  },
  {
    why: 'a blank page',
    url: 'about:blank',
  },
  {
    why: 'text that is not a URL',
    url: 'not a url',
  },
];

const ALL_URLS = [
  { why: 'an artifact page it would admit', url: ARTIFACT_PAGE },
  ...REFUSED,
];

describe('isAllowedArtifactFrameNavigation', () => {
  it('admits an artifact page on the daemon origin', () => {
    expect(isAllowedArtifactFrameNavigation(ARTIFACT_PAGE, DAEMON_ORIGIN)).toBe(
      true,
    );
  });

  it.each(REFUSED)('refuses $why ($url)', ({ url }) => {
    expect(isAllowedArtifactFrameNavigation(url, DAEMON_ORIGIN)).toBe(false);
  });

  // Reachable only through an https origin: against an http one, every https
  // URL has already failed the origin comparison.
  it('refuses https even when that is the origin it was given', () => {
    expect(
      isAllowedArtifactFrameNavigation(
        'https://127.0.0.1:47615/v1/artifacts/x',
        'https://127.0.0.1:47615',
      ),
    ).toBe(false);
  });

  describe('with no daemon up', () => {
    it.each(ALL_URLS)('refuses $why ($url)', ({ url }) => {
      expect(isAllowedArtifactFrameNavigation(url, null)).toBe(false);
    });
  });
});

describe('guardArtifactFrameNavigations', () => {
  type FrameNavigation = {
    readonly isMainFrame: boolean;
    readonly url: string;
    preventDefault: () => void;
  };

  /** A WebContents double that keeps the one listener the guard installs. */
  function contentsRecorder(): {
    contents: Pick<WebContents, 'on'>;
    registrations: string[];
    navigate: (isMainFrame: boolean, url: string) => boolean;
  } {
    const registrations: string[] = [];
    let listener: ((event: FrameNavigation) => void) | null = null;
    const contents = {
      on: (name: string, next: (event: FrameNavigation) => void) => {
        registrations.push(name);
        listener = next;
      },
    } as unknown as Pick<WebContents, 'on'>;
    return {
      contents,
      registrations,
      navigate: (isMainFrame, url) => {
        let prevented = false;
        listener?.({
          isMainFrame,
          url,
          preventDefault: () => {
            prevented = true;
          },
        });
        return prevented;
      },
    };
  }

  it('listens for will-frame-navigate, and only that', () => {
    const { contents, registrations } = contentsRecorder();
    guardArtifactFrameNavigations(contents, () => DAEMON_ORIGIN);
    expect(registrations).toEqual(['will-frame-navigate']);
  });

  it('cancels a subframe navigation to anything but an artifact page', () => {
    const { contents, navigate } = contentsRecorder();
    guardArtifactFrameNavigations(contents, () => DAEMON_ORIGIN);
    expect(navigate(false, 'https://example.com/x')).toBe(true);
  });

  it('lets a subframe load an artifact page from the running daemon', () => {
    const { contents, navigate } = contentsRecorder();
    guardArtifactFrameNavigations(contents, () => DAEMON_ORIGIN);
    expect(navigate(false, ARTIFACT_PAGE)).toBe(false);
  });

  it('leaves a main-frame navigation to the top-frame guards in index.ts', () => {
    const { contents, navigate } = contentsRecorder();
    guardArtifactFrameNavigations(contents, () => DAEMON_ORIGIN);
    expect(navigate(true, 'https://example.com/x')).toBe(false);
  });

  it('cancels every subframe navigation while no daemon is up', () => {
    const { contents, navigate } = contentsRecorder();
    guardArtifactFrameNavigations(contents, () => null);
    expect(navigate(false, ARTIFACT_PAGE)).toBe(true);
  });
});
