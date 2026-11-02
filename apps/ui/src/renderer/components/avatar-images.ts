import { createContext, useContext, useEffect, useState } from 'react';

/** Reads one stored member picture back as a `data:` URL. */
export type AvatarImageLoader = (id: string) => Promise<string>;

/**
 * How a member's picture reaches the screen. Null outside a provider: the
 * avatar then draws its initials. The renderer CSP is `img-src 'self' data:`,
 * so the daemon answers a data URI, never a URL to fetch.
 */
export const AvatarImageLoaderContext = createContext<AvatarImageLoader | null>(
  null,
);

const loaded = new Map<string, Promise<string>>();
const resolved = new Map<string, string>();

/**
 * Picture ids are content hashes, so one answer is good for the session; a
 * refusal is dropped from the cache so the next mount asks again.
 */
function loadOnce(loader: AvatarImageLoader, id: string): Promise<string> {
  const held = loaded.get(id);
  if (held !== undefined) {
    return held;
  }
  const pending = loader(id);
  loaded.set(id, pending);
  pending.then(
    (src) => resolved.set(id, src),
    () => loaded.delete(id),
  );
  return pending;
}

export type AvatarImageState =
  | { status: 'none' }
  | { status: 'loading' }
  | { status: 'ready'; src: string }
  | { status: 'failed' };

/** The picture for `id`, read through the nearest loader. */
export function useAvatarImage(id: string | null): AvatarImageState {
  const loader = useContext(AvatarImageLoaderContext);
  const known = id === null ? undefined : resolved.get(id);
  const [state, setState] = useState<AvatarImageState>(() =>
    id === null || loader === null
      ? { status: 'none' }
      : known === undefined
        ? { status: 'loading' }
        : { status: 'ready', src: known },
  );
  useEffect(() => {
    if (id === null || loader === null) {
      setState({ status: 'none' });
      return;
    }
    let live = true;
    const ready = resolved.get(id);
    setState(
      ready === undefined
        ? { status: 'loading' }
        : { status: 'ready', src: ready },
    );
    loadOnce(loader, id).then(
      (src) => {
        if (live) {
          setState({ status: 'ready', src });
        }
      },
      () => {
        if (live) {
          setState({ status: 'failed' });
        }
      },
    );
    return () => {
      live = false;
    };
  }, [id, loader]);
  return state;
}
