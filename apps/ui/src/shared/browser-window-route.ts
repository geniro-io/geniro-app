const BROWSER_WINDOW_VIEW = 'browser-window';

export interface BrowserWindowRoute {
  runId: string;
  title: string;
}

/** The hash, without `#`, that a chat's pop-out browser window loads the renderer at. */
export function browserWindowHash({
  runId,
  title,
}: BrowserWindowRoute): string {
  return `${BROWSER_WINDOW_VIEW}?${new URLSearchParams({ run: runId, title }).toString()}`;
}

export function parseBrowserWindowHash(
  hash: string,
): BrowserWindowRoute | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const [view, query = ''] = raw.split('?', 2);
  if (view !== BROWSER_WINDOW_VIEW) {
    return null;
  }
  const params = new URLSearchParams(query);
  const runId = params.get('run');
  if (runId === null || runId === '') {
    return null;
  }
  return { runId, title: params.get('title') ?? '' };
}
