import { ArtifactCard } from './artifact-block';
import { GalleryCard } from './gallery-block';
import type { ThreadContextVisual } from './thread-question-context';

/**
 * A page or a set of pictures the relayed question's thread showed before it
 * asked, drawn with the transcript's own cards. They read their page URL and
 * their pictures through the contexts `QuestionContextMessages` binds to the
 * thread's run, so a card here is the card the thread drew.
 */
export function QuestionContextVisual({
  entry,
}: {
  entry: ThreadContextVisual;
}): React.JSX.Element {
  return (
    <div data-slot="thread-question-context-visual" className="min-w-0">
      {'artifact' in entry ? (
        <ArtifactCard artifact={entry.artifact} />
      ) : (
        <GalleryCard gallery={entry.gallery} />
      )}
    </div>
  );
}
