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

/** The shortest title or page id the question's words may name a page or picture set by. */
export const MIN_NAMED_TITLE_LENGTH = 6;

export type QuestionAttachment =
  | { kind: 'artifact'; artifactId: string; title: string; version: number }
  | {
      kind: 'gallery';
      seq: number;
      title: string | null;
      count: number;
      gallery: Record<string, unknown>;
    };

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

/** One `show_gallery` row of the run, its payload as stored. */
export interface QuestionGallery {
  seq: number;
  payload: Record<string, unknown>;
}

export interface QuestionAttachmentInputs {
  /** Page ids the asking agent passed, in its order; each already checked to be the run's. */
  explicit: readonly string[];
  /** Every word the card shows: its title, each question, header and option. */
  text: string;
  pages: readonly QuestionPage[];
  galleries: readonly QuestionGallery[];
  /** The asking turn's `show_artifact` page ids and `show_gallery` seqs, oldest first. */
  turn: readonly ({ artifactId: string } | { gallerySeq: number })[];
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function namesTitle(text: string, title: string | null): boolean {
  if (title === null) {
    return false;
  }
  const wanted = collapse(title);
  return (
    wanted.length >= MIN_NAMED_TITLE_LENGTH &&
    text.toLowerCase().includes(wanted.toLowerCase())
  );
}

function namesId(text: string, artifactId: string): boolean {
  if (artifactId.length < MIN_NAMED_TITLE_LENGTH) {
    return false;
  }
  return new RegExp(
    `(^|[^\\p{L}\\p{N}_-])${escapeRegExp(artifactId)}($|[^\\p{L}\\p{N}_-])`,
    'u',
  ).test(text);
}

function galleryTitle(payload: Record<string, unknown>): string | null {
  return typeof payload.title === 'string' && payload.title.trim().length > 0
    ? payload.title.trim()
    : null;
}

function galleryCount(payload: Record<string, unknown>): number {
  return Array.isArray(payload.images) ? payload.images.length : 0;
}

/**
 * The card's attachments, explicit first, then named in its words, then the
 * asking turn's, newest turn rows first; one entry per page and per picture set,
 * at most {@link MAX_QUESTION_ATTACHMENTS}, the rest counted.
 */
export function questionAttachmentsOf(
  inputs: QuestionAttachmentInputs,
): QuestionAttachmentFields {
  const pages = new Map(inputs.pages.map((page) => [page.artifactId, page]));
  const galleries = new Map(
    inputs.galleries
      .filter((gallery) => galleryCount(gallery.payload) > 0)
      .map((gallery) => [gallery.seq, gallery]),
  );
  const text = collapse(inputs.text);
  const found: QuestionAttachment[] = [];
  const seen = new Set<string>();
  const addPage = (artifactId: string): void => {
    const page = pages.get(artifactId);
    if (page === undefined || seen.has(`a:${artifactId}`)) {
      return;
    }
    seen.add(`a:${artifactId}`);
    found.push({
      kind: 'artifact',
      artifactId,
      title: page.title,
      version: page.version,
    });
  };
  const addGallery = (seq: number): void => {
    const gallery = galleries.get(seq);
    if (gallery === undefined || seen.has(`g:${seq}`)) {
      return;
    }
    seen.add(`g:${seq}`);
    found.push({
      kind: 'gallery',
      seq,
      title: galleryTitle(gallery.payload),
      count: galleryCount(gallery.payload),
      gallery: gallery.payload,
    });
  };
  for (const artifactId of inputs.explicit) {
    addPage(artifactId);
  }
  for (const page of inputs.pages) {
    if (namesTitle(text, page.title) || namesId(text, page.artifactId)) {
      addPage(page.artifactId);
    }
  }
  for (const gallery of [...galleries.values()].sort((a, b) => b.seq - a.seq)) {
    if (namesTitle(text, galleryTitle(gallery.payload))) {
      addGallery(gallery.seq);
    }
  }
  for (const row of [...inputs.turn].reverse()) {
    if ('artifactId' in row) {
      addPage(row.artifactId);
    } else {
      addGallery(row.gallerySeq);
    }
  }
  return {
    attachments: found.slice(0, MAX_QUESTION_ATTACHMENTS),
    moreAttachments: Math.max(0, found.length - MAX_QUESTION_ATTACHMENTS),
  };
}

/** Every word a question card shows, read from its `questions` payload. */
export function questionCardText(
  title: string | null,
  questions: unknown,
): string {
  const words: string[] = title === null ? [] : [title];
  const push = (value: unknown): void => {
    if (typeof value === 'string') {
      words.push(value);
    }
  };
  for (const question of Array.isArray(questions) ? questions : []) {
    if (typeof question !== 'object' || question === null) {
      continue;
    }
    const bag = question as Record<string, unknown>;
    push(bag.question);
    push(bag.header);
    for (const option of Array.isArray(bag.options) ? bag.options : []) {
      if (typeof option === 'object' && option !== null) {
        const entry = option as Record<string, unknown>;
        push(entry.label);
        push(entry.description);
        push(entry.preview);
      }
    }
  }
  return words.join('\n');
}
