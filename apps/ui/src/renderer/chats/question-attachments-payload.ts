import { recordOf } from './tool-result-text';

/**
 * The tool whose questions can attach pages: the only one that can pass them
 * explicitly. A question asked through any other tool attaches none, whatever
 * its row stores.
 *
 * TWIN PARSER: `HOST_QUESTION_TOOL` in `apps/daemon/src/v1/agents/chat.types.ts`.
 */
export const ASK_USER_QUESTION_TOOL = 'ask_user_question';

/**
 * A page a question card shows: one its agent passed in `ask_user_question`'s
 * `artifacts`, as the daemon resolved it when it wrote the question. A page names
 * its id and title and never its key: the key is read from the thread's own
 * listing when the card draws it.
 *
 * TWIN PARSER: `apps/daemon/src/v1/agents/utils/question-attachments.ts`, which
 * writes these keys onto a question row and onto the relayed card. A key renamed
 * on either side must be renamed on both.
 */
export type QuestionAttachment = {
  kind: 'artifact';
  artifactId: string;
  title: string;
  version: number;
};

export interface QuestionAttachmentSet {
  attachments: QuestionAttachment[];
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
  if (entry === null || entry.kind !== 'artifact') {
    return null;
  }
  const artifactId = readText(entry.artifactId);
  const title = readText(entry.title);
  const version = readWhole(entry.version, 1);
  return artifactId === null || title === null || version === null
    ? null
    : { kind: 'artifact', artifactId, title, version };
}

/**
 * The pages a question carries, read from its record (a question row's payload,
 * or the relayed card's input). Null when the record has NO `attachments` key: it
 * was written before attachments existed. A record of any other tool carries
 * none, whatever it stores. A malformed entry is dropped alone, and a page listed
 * twice counts once, at its first place.
 */
export function readQuestionAttachmentSet(
  record: Record<string, unknown> | null,
): QuestionAttachmentSet | null {
  if (record === null || record.attachments === undefined) {
    return null;
  }
  if (record.toolName !== ASK_USER_QUESTION_TOOL) {
    return { attachments: [] };
  }
  const entries = Array.isArray(record.attachments) ? record.attachments : [];
  const seen = new Set<string>();
  const attachments: QuestionAttachment[] = [];
  for (const attachment of entries.map(readAttachment)) {
    if (attachment !== null && !seen.has(attachment.artifactId)) {
      seen.add(attachment.artifactId);
      attachments.push(attachment);
    }
  }
  return { attachments };
}

/** The attachments of a question row's payload; see {@link readQuestionAttachmentSet}. */
export function questionAttachmentSetOf(
  payload: unknown,
): QuestionAttachmentSet | null {
  return readQuestionAttachmentSet(recordOf(payload));
}
