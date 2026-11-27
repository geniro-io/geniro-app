import { type GallerySpec, readGallerySpec } from './gallery-payload';
import { recordOf } from './tool-result-text';

/**
 * A page or a set of pictures a question card shows, as the daemon resolved it
 * when it wrote the question. A page names its id and title and never its key:
 * the key is read from the thread's own listing when the card draws it.
 *
 * TWIN PARSER: `apps/daemon/src/v1/agents/utils/question-attachments.ts`, which
 * writes these keys onto a question row and onto the relayed card. A key renamed
 * on either side must be renamed on both.
 */
export type QuestionAttachment =
  | { kind: 'artifact'; artifactId: string; title: string; version: number }
  | { kind: 'gallery'; seq: number; gallery: GallerySpec };

export interface QuestionAttachmentSet {
  attachments: QuestionAttachment[];
  moreAttachments: number;
}

function readText(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function readWhole(value: unknown, least: number): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= least
    ? value
    : null;
}

function readAttachment(value: unknown): QuestionAttachment | null {
  const entry = recordOf(value);
  if (entry === null) {
    return null;
  }
  if (entry.kind === 'artifact') {
    const artifactId = readText(entry.artifactId);
    const title = readText(entry.title);
    const version = readWhole(entry.version, 1);
    return artifactId === null || title === null || version === null
      ? null
      : { kind: 'artifact', artifactId, title, version };
  }
  if (entry.kind === 'gallery') {
    const seq = readWhole(entry.seq, 0);
    const gallery = readGallerySpec(entry.gallery);
    return seq === null || gallery === null
      ? null
      : { kind: 'gallery', seq, gallery };
  }
  return null;
}

/**
 * The attachments a question carries, read from its record (a question row's
 * payload, or the relayed card's input). Null when the record has NO
 * `attachments` key: it was written before attachments existed, and keeps the
 * reader of the thread's messages. An empty list is a question written after
 * them that attached nothing. A malformed entry is dropped alone.
 */
export function readQuestionAttachmentSet(
  record: Record<string, unknown> | null,
): QuestionAttachmentSet | null {
  if (record === null || record.attachments === undefined) {
    return null;
  }
  const entries = Array.isArray(record.attachments) ? record.attachments : [];
  return {
    attachments: entries
      .map(readAttachment)
      .filter(
        (attachment): attachment is QuestionAttachment => attachment !== null,
      ),
    moreAttachments: readWhole(record.moreAttachments, 0) ?? 0,
  };
}

/** The attachments of a question row's payload; see {@link readQuestionAttachmentSet}. */
export function questionAttachmentSetOf(
  payload: unknown,
): QuestionAttachmentSet | null {
  return readQuestionAttachmentSet(recordOf(payload));
}
