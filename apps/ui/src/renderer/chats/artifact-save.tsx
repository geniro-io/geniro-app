import { Download } from 'lucide-react';
import { useCallback, useContext, useState } from 'react';

import { Button } from '../components/ui/button';
import { cn } from '../components/ui/utils';
import { artifactFileName, buildArtifactFile } from './artifact-export';
import {
  ArtifactUrlContext,
  type PublishedArtifact,
} from './published-artifact';

export interface ArtifactSaver {
  save: (artifact: PublishedArtifact) => void;
  /** True while the document is being fetched or the panel is open. */
  saving: boolean;
  /** The last failure, or null. A CANCEL is not one. */
  error: string | null;
}

/**
 * Saving one published page as a file the user can send somebody.
 *
 * A hook rather than a component, because a card draws the control TWICE — in
 * the transcript heading and again in the full-screen dialog's title slot —
 * and both presses are the same act on the same document. Two components each
 * owning their own state would give one card two independent "saving…" flags
 * and two places for a failure to be reported.
 *
 * A CANCELLED save panel leaves no trace: `saved: false` is the commonest
 * outcome of opening one, and it earns silence rather than an error line (see
 * `FileSaveResult`). Only a document that could not be read, or a write that
 * genuinely failed, reaches {@link ArtifactSaver.error}.
 */
export function useArtifactSaver(): ArtifactSaver {
  const urlFor = useContext(ArtifactUrlContext);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = useCallback(
    (artifact: PublishedArtifact) => {
      if (urlFor === null) {
        return;
      }
      setSaving(true);
      setError(null);
      // The RAW reading: what the agent wrote, without this app's frame
      // wrapper — see `artifact-export.ts`.
      void buildArtifactFile(urlFor(artifact, { raw: true }))
        .then((html) =>
          window.geniro.saveArtifact({
            suggestedName: artifactFileName(artifact),
            html,
          }),
        )
        .catch((err: unknown) => {
          setError(String(err));
        })
        .finally(() => {
          setSaving(false);
        });
    },
    [urlFor],
  );

  return { save, saving, error };
}

/**
 * The control itself — an icon button, drawn wherever a page can be reached.
 *
 * It renders NOTHING without a URL builder in context, on the rule the frame
 * beside it follows: a page this app cannot address is one it cannot fetch, so
 * a button here would be a press that silently does nothing.
 */
export function ArtifactSaveButton({
  artifact,
  saver,
  className,
}: {
  artifact: PublishedArtifact;
  saver: ArtifactSaver;
  className?: string;
}): React.JSX.Element | null {
  const urlFor = useContext(ArtifactUrlContext);
  if (urlFor === null) {
    return null;
  }
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      disabled={saver.saving}
      className={cn('shrink-0 text-muted-foreground', className)}
      aria-label={`Save ${artifact.title} as an HTML file`}
      onClick={() => saver.save(artifact)}>
      <Download className="size-3" />
    </Button>
  );
}
