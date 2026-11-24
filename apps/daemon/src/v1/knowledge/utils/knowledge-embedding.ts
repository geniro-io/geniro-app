import { createHash } from 'node:crypto';

const HEADING = /^#{1,6}\s/;

/** The text a document's meaning vectors were made from, pinned: any edit of the three fields changes it. */
export function knowledgeTextHash(
  title: string,
  whenToRead: string,
  body: string,
): string {
  return createHash('sha256')
    .update(`${title}\n${whenToRead}\n${body}`)
    .digest('hex');
}

/**
 * A document as search by meaning reads it: one piece per Markdown section,
 * each led by the title and the when-to-read line so a section is found by
 * what the whole document is about. Sections too long for the model are split
 * further by the embedding child.
 */
export function knowledgeEmbeddingChunks(
  title: string,
  whenToRead: string,
  body: string,
): string[] {
  const head = [title.trim(), whenToRead.trim()]
    .filter((part) => part !== '')
    .join('\n');
  const sections: string[] = [];
  let current: string[] = [];
  for (const line of body.split('\n')) {
    if (HEADING.test(line) && current.some((kept) => kept.trim() !== '')) {
      sections.push(current.join('\n'));
      current = [];
    }
    current.push(line);
  }
  sections.push(current.join('\n'));
  const pieces = sections
    .map((section) => section.trim())
    .filter((section) => section !== '');
  if (pieces.length === 0) {
    return head === '' ? [] : [head];
  }
  return pieces.map((section) =>
    head === '' ? section : `${head}\n\n${section}`,
  );
}
