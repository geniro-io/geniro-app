import { useContext, useEffect, useState } from 'react';

import type { PublishedArtifact } from './published-artifact';
import { QuestionAttachments } from './question-attachments';
import type { QuestionAttachmentSet } from './question-attachments-payload';
import { ThreadContextReaderContext } from './thread-question-context';

/** A finished thread's published pages as a set its card draws as chips, newest listing order kept. */
function donePagesSetOf(
  pages: readonly PublishedArtifact[],
): QuestionAttachmentSet {
  return {
    attachments: pages.map((page) => ({
      kind: 'artifact',
      artifactId: page.artifactId,
      title: page.title,
      version: page.version,
    })),
  };
}

/**
 * The pages a finished thread published, as chips that open each one — read
 * from the thread's own listing, so the card shows what the thread made
 * without opening its chat. Draws nothing while the listing is read, when it
 * cannot be, or when the thread published none.
 */
export function ThreadDonePages({
  runId,
}: {
  runId: string;
}): React.JSX.Element | null {
  const reader = useContext(ThreadContextReaderContext);
  const [read, setRead] = useState<{
    runId: string;
    pages: readonly PublishedArtifact[];
  } | null>(null);
  useEffect(() => {
    if (reader === null) {
      return undefined;
    }
    let live = true;
    reader.artifacts(runId).then(
      (pages) => {
        if (live) {
          setRead({ runId, pages });
        }
      },
      () => {
        if (live) {
          setRead({ runId, pages: [] });
        }
      },
    );
    return () => {
      live = false;
    };
  }, [reader, runId]);
  if (read === null || read.runId !== runId || read.pages.length === 0) {
    return null;
  }
  return (
    <div data-slot="thread-done-pages" className="min-w-0">
      <QuestionAttachments
        threadRunId={runId}
        set={donePagesSetOf(read.pages)}
        variant="chips"
      />
    </div>
  );
}
