import type { LocalImageLoader } from '../chats/local-image-loader';
import type {
  ArtifactAnswersStore,
  ArtifactUrlBuilder,
} from '../chats/published-artifact';
import type { ThreadContextReader } from '../chats/thread-question-context';

/** A 1×1 PNG, the picture a stub loader answers with. */
export const STUB_PICTURE_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

/** An answers store that keeps a page's picks in memory, merged per page. */
function memoryAnswersStore(): ArtifactAnswersStore {
  const kept = new Map<string, Record<string, unknown>>();
  return {
    read: (artifactId) => Promise.resolve({ ...kept.get(artifactId) }),
    save: (artifactId, changes) => {
      const merged = { ...kept.get(artifactId), ...changes };
      kept.set(artifactId, merged);
      return Promise.resolve(merged);
    },
    subscribe: () => () => undefined,
  };
}

/**
 * A thread context reader for specs and stories: `read` answers what it is
 * given, and the page URL, picture loader and answers store are the stub's own
 * unless passed.
 */
export function stubThreadContextReader(
  read: ThreadContextReader['read'],
  options: {
    artifactUrl?: (threadRunId: string) => ArtifactUrlBuilder;
    loadImage?: (threadRunId: string) => LocalImageLoader;
    answers?: (threadRunId: string) => ArtifactAnswersStore;
  } = {},
): ThreadContextReader {
  return {
    read,
    artifactUrl:
      options.artifactUrl ??
      ((threadRunId) => (artifact) =>
        `http://127.0.0.1:1/v1/artifacts/${threadRunId}/${artifact.artifactId}?v=${artifact.version}`),
    loadImage:
      options.loadImage ??
      (() => () => Promise.reject(new Error('no picture loader in this stub'))),
    answers: options.answers ?? memoryAnswersStore,
  };
}
