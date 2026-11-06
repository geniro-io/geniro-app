import { FILE_HEADERS_ONLY, formatPatch, structuredPatch } from 'diff';

const DIFF_CONTEXT = 3;

/** A diff of two whole bodies may hold the event loop; past this it gives up. */
const DIFF_TIMEOUT_MS = 1500;

/** The text of one version as a review reads it. */
export interface KnowledgeVersionText {
  title: string;
  whenToRead: string;
  body: string;
}

function versionText(version: KnowledgeVersionText | null): string {
  return version === null
    ? ''
    : `# ${version.title}\n\nWhen to read: ${version.whenToRead}\n\n${version.body}\n`;
}

/**
 * The unified diff from `base` to `next`. Empty when they are the same, and
 * when two very different long texts take too long to compare: the review
 * screen then shows the proposed text whole.
 */
export function knowledgeDiff(
  handle: string,
  base: KnowledgeVersionText | null,
  next: KnowledgeVersionText,
): string {
  const file = `${handle}.md`;
  const patch = structuredPatch(
    `a/${file}`,
    `b/${file}`,
    versionText(base),
    versionText(next),
    undefined,
    undefined,
    { context: DIFF_CONTEXT, timeout: DIFF_TIMEOUT_MS },
  );
  return !patch || patch.hunks.length === 0
    ? ''
    : formatPatch(patch, FILE_HEADERS_ONLY).trimEnd();
}

type KnowledgeExportable = KnowledgeVersionText & {
  handle: string;
  rev: number;
};

/** One document as Markdown a person can keep. */
function documentMarkdown(document: KnowledgeExportable): string {
  return [
    `# ${document.title}`,
    `> When to read: ${document.whenToRead}`,
    `> Handle: \`${document.handle}\` · rev ${document.rev}`,
    document.body,
  ].join('\n\n');
}

export function knowledgeExportMarkdown(
  documents: readonly KnowledgeExportable[],
): string {
  return `${documents.map(documentMarkdown).join('\n\n---\n\n')}\n`;
}
