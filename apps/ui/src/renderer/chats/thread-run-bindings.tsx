import { useMemo } from 'react';

import { ArtifactShareContext } from './artifact-share';
import { LocalImageLoaderContext } from './local-image-loader';
import {
  ArtifactAnswersContext,
  ArtifactUrlContext,
} from './published-artifact';
import type { ThreadContextReader } from './thread-question-context';

/**
 * Binds a page's URL, its pictures and its answers to the THREAD's run — the run
 * a question asks from, not the run the card is drawn in. Share is off: a page
 * shown on a question card is not shared from it.
 */
export function ThreadRunBindings({
  reader,
  threadRunId,
  children,
}: {
  reader: ThreadContextReader;
  threadRunId: string;
  children: React.ReactNode;
}): React.JSX.Element {
  const artifactUrl = useMemo(
    () => reader.artifactUrl(threadRunId),
    [reader, threadRunId],
  );
  const loadImage = useMemo(
    () => reader.loadImage(threadRunId),
    [reader, threadRunId],
  );
  const answers = useMemo(
    () => reader.answers(threadRunId),
    [reader, threadRunId],
  );
  return (
    <LocalImageLoaderContext.Provider value={loadImage}>
      <ArtifactUrlContext.Provider value={artifactUrl}>
        <ArtifactShareContext.Provider value={null}>
          <ArtifactAnswersContext.Provider value={answers}>
            {children}
          </ArtifactAnswersContext.Provider>
        </ArtifactShareContext.Provider>
      </ArtifactUrlContext.Provider>
    </LocalImageLoaderContext.Provider>
  );
}
