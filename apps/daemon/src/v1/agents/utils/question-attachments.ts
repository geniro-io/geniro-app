/**
 * The pages and pictures a question card is about, resolved once when its
 * `approval_request` row is written and kept on that row.
 *
 * TWIN PARSER: `apps/ui/src/renderer/chats/question-attachments-payload.ts`
 * reads `attachments` / `moreAttachments` back off the row and off the
 * relayed card (`ThreadQuestionCardInput`). A key renamed here is renamed
 * there. A page's serving key is never stored: the renderer reads it from the
 * thread's own artifact listing when it draws the card.
 */

export const MAX_QUESTION_ATTACHMENTS = 3;

export interface QuestionAttachment {
  kind: 'artifact';
  artifactId: string;
  title: string;
  version: number;
}

export interface QuestionAttachmentFields {
  attachments: QuestionAttachment[];
  moreAttachments: number;
}

export const NO_QUESTION_ATTACHMENTS: QuestionAttachmentFields = {
  attachments: [],
  moreAttachments: 0,
};

/** One page of the run at its newest version, as its artifact listing names it. */
export interface QuestionPage {
  artifactId: string;
  title: string;
  version: number;
}

/**
 * The card's attachments: exactly the pages the asking agent passed, each once
 * at its newest version, in its order. Nothing is ever attached for it — a
 * question that passed none attaches none.
 */
export function questionAttachmentsOf(
  explicit: readonly string[],
  pages: readonly QuestionPage[],
): QuestionAttachmentFields {
  const byId = new Map(pages.map((page) => [page.artifactId, page]));
  const attachments = [...new Set(explicit)].flatMap(
    (artifactId): QuestionAttachment[] => {
      const page = byId.get(artifactId);
      return page === undefined
        ? []
        : [{ kind: 'artifact', artifactId, title: page.title, version: page.version }];
    },
  );
  return {
    attachments: attachments.slice(0, MAX_QUESTION_ATTACHMENTS),
    moreAttachments: 0,
  };
}
