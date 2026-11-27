import { FileText, FileX, Images } from 'lucide-react';
import { useContext, useEffect, useState } from 'react';

import { Button } from '../components/ui/button';
import { Chip } from '../components/ui/chip';
import { Dialog } from '../components/ui/dialog';
import { ArtifactCard } from './artifact-block';
import { ArtifactDialog } from './artifact-dialog';
import { GalleryCard } from './gallery-block';
import { type GallerySpec } from './gallery-payload';
import type { PublishedArtifact } from './published-artifact';
import type {
  QuestionAttachment,
  QuestionAttachmentSet,
} from './question-attachments-payload';
import {
  type ThreadContextReader,
  ThreadContextReaderContext,
} from './thread-question-context';
import { ThreadRunBindings } from './thread-run-bindings';
import { ThreadOpenContext } from './thread-title';

/** What a question card says of a page that is no longer there. */
export const PAGE_UNAVAILABLE_TEXT =
  'This page is no longer available — its chat was deleted or the page was removed. The question can still be answered.';

type ArtifactAttachment = Extract<QuestionAttachment, { kind: 'artifact' }>;

/** The thread's pages by id; null while its listing is read, 'failed' when it cannot be. */
type Pages = Map<string, PublishedArtifact> | 'failed' | null;

/** The page an attachment names: 'gone' when the listing does not hold it. */
type Page = PublishedArtifact | 'gone' | null;

/**
 * The thread's pages, read once per thread run. The listing carries each page's
 * key, which an attachment does not; a listing that cannot be read leaves every
 * page unavailable rather than failing the question.
 */
function usePages(reader: ThreadContextReader, threadRunId: string): Pages {
  const [read, setRead] = useState<{
    reader: ThreadContextReader;
    threadRunId: string;
    pages: Map<string, PublishedArtifact> | 'failed';
  } | null>(null);
  useEffect(() => {
    let current = true;
    const settle = (pages: Map<string, PublishedArtifact> | 'failed') => {
      if (current) {
        setRead({ reader, threadRunId, pages });
      }
    };
    reader.artifacts(threadRunId).then(
      (listed) =>
        settle(new Map(listed.map((page) => [page.artifactId, page]))),
      () => settle('failed'),
    );
    return () => {
      current = false;
    };
  }, [reader, threadRunId]);
  if (
    read === null ||
    read.reader !== reader ||
    read.threadRunId !== threadRunId
  ) {
    return null;
  }
  return read.pages;
}

function pageOf(attachment: ArtifactAttachment, pages: Pages): Page {
  if (pages === null) {
    return null;
  }
  if (pages === 'failed') {
    return 'gone';
  }
  return pages.get(attachment.artifactId) ?? 'gone';
}

function keyOf(attachment: QuestionAttachment): string {
  return attachment.kind === 'artifact'
    ? attachment.artifactId
    : `gallery-${attachment.seq}`;
}

function PageGone({ title }: { title: string }): React.JSX.Element {
  return (
    <div
      data-slot="question-attachment-unavailable"
      className="flex min-w-0 items-start gap-2 rounded-md border border-dashed border-border px-2.5 py-2 text-xs text-muted-foreground">
      <FileX aria-hidden="true" className="mt-px size-3.5 shrink-0" />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="truncate font-medium text-foreground" title={title}>
          {title}
        </span>
        <span>{PAGE_UNAVAILABLE_TEXT}</span>
      </span>
    </div>
  );
}

function PagePreview({
  attachment,
  pages,
}: {
  attachment: ArtifactAttachment;
  pages: Pages;
}): React.JSX.Element {
  const page = pageOf(attachment, pages);
  if (page === null) {
    return (
      <p role="status" className="text-xs text-muted-foreground">
        Loading {attachment.title}…
      </p>
    );
  }
  if (page === 'gone') {
    return <PageGone title={attachment.title} />;
  }
  return <ArtifactCard artifact={page} labelledFullScreen />;
}

function PageChip({
  attachment,
  pages,
}: {
  attachment: ArtifactAttachment;
  pages: Pages;
}): React.JSX.Element {
  const page = pageOf(attachment, pages);
  const [viewing, setViewing] = useState(false);
  const gone = page === 'gone';
  const name = gone ? `${attachment.title}, unavailable` : attachment.title;
  return (
    <>
      <Chip asChild interactive tone={gone ? 'muted' : 'active'}>
        <button
          type="button"
          data-slot="question-attachment-chip"
          data-state={
            gone ? 'unavailable' : page === null ? 'loading' : 'available'
          }
          title={attachment.title}
          aria-label={name}
          disabled={page === null || gone}
          onClick={() => setViewing(true)}
          className="max-w-full">
          <FileText aria-hidden="true" />
          <span className="min-w-0 truncate">{attachment.title}</span>
        </button>
      </Chip>
      {page === null || gone ? null : (
        <ArtifactDialog
          artifact={page}
          open={viewing}
          onClose={() => setViewing(false)}
        />
      )}
    </>
  );
}

function GalleryChip({ gallery }: { gallery: GallerySpec }): React.JSX.Element {
  const [viewing, setViewing] = useState(false);
  const count = gallery.images.length;
  const label = [
    `${count} ${count === 1 ? 'picture' : 'pictures'}`,
    gallery.title,
  ]
    .filter((part): part is string => part !== null)
    .join(' · ');
  return (
    <>
      <Chip asChild interactive tone="active">
        <button
          type="button"
          data-slot="question-attachment-chip"
          title={label}
          aria-label={label}
          onClick={() => setViewing(true)}
          className="max-w-full">
          <Images aria-hidden="true" />
          <span className="min-w-0 truncate">{label}</span>
        </button>
      </Chip>
      <Dialog
        open={viewing}
        onClose={() => setViewing(false)}
        title={gallery.title ?? 'Pictures'}>
        <GalleryCard gallery={gallery} />
      </Dialog>
    </>
  );
}

function MoreAttachments({
  threadRunId,
  count,
}: {
  threadRunId: string;
  count: number;
}): React.JSX.Element | null {
  const open = useContext(ThreadOpenContext);
  if (count === 0) {
    return null;
  }
  const label = `+${count} more`;
  return open === null ? (
    <span
      data-slot="question-attachments-more"
      className="text-xs text-muted-foreground">
      {label}
    </span>
  ) : (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      data-slot="question-attachments-more"
      title="Show this thread and open its chat"
      className="text-xs text-muted-foreground"
      onClick={() => open(threadRunId)}>
      {label}
    </Button>
  );
}

function AttachmentList({
  reader,
  threadRunId,
  set,
  variant,
}: {
  reader: ThreadContextReader;
  threadRunId: string;
  set: QuestionAttachmentSet;
  variant: 'preview' | 'chips';
}): React.JSX.Element {
  const pages = usePages(reader, threadRunId);
  if (variant === 'chips') {
    return (
      <div
        data-slot="question-attachments"
        data-variant="chips"
        className="flex min-w-0 flex-wrap items-center gap-1.5">
        {set.attachments.map((attachment) =>
          attachment.kind === 'artifact' ? (
            <PageChip
              key={keyOf(attachment)}
              attachment={attachment}
              pages={pages}
            />
          ) : (
            <GalleryChip key={keyOf(attachment)} gallery={attachment.gallery} />
          ),
        )}
        <MoreAttachments
          threadRunId={threadRunId}
          count={set.moreAttachments}
        />
      </div>
    );
  }
  return (
    <div
      data-slot="question-attachments"
      data-variant="preview"
      className="flex min-w-0 flex-col gap-2">
      {set.attachments.map((attachment) =>
        attachment.kind === 'artifact' ? (
          <PagePreview
            key={keyOf(attachment)}
            attachment={attachment}
            pages={pages}
          />
        ) : (
          <GalleryCard key={keyOf(attachment)} gallery={attachment.gallery} />
        ),
      )}
      <MoreAttachments threadRunId={threadRunId} count={set.moreAttachments} />
    </div>
  );
}

/**
 * The pages and pictures a question was asked about, drawn on its card.
 *
 * `preview` draws each page inline with its labelled full-screen button, as the
 * asking turn's pages are drawn; `chips` draws one chip per attachment and
 * loads nothing but the thread's listing until a chip is pressed, which then
 * opens the page or the picture set. A page the listing does not hold — or a
 * listing that cannot be read — is unavailable: a placeholder, or an
 * "unavailable" chip. Bound to the thread's run, as the reader's pages are.
 */
export function QuestionAttachments({
  threadRunId,
  set,
  variant,
}: {
  threadRunId: string;
  set: QuestionAttachmentSet;
  variant: 'preview' | 'chips';
}): React.JSX.Element | null {
  const reader = useContext(ThreadContextReaderContext);
  if (reader === null) {
    return null;
  }
  return (
    <ThreadRunBindings reader={reader} threadRunId={threadRunId}>
      <AttachmentList
        reader={reader}
        threadRunId={threadRunId}
        set={set}
        variant={variant}
      />
    </ThreadRunBindings>
  );
}
