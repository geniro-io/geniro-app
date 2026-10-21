import { createContext } from 'react';

/** How a node stands against the saved workflow a proposal replaces. */
export type PreviewMark = 'added' | 'changed';

/**
 * Set only around a read-only preview (a proposal card's graph). Node cards
 * read it to drop what edits a canvas — delete, the ports toggle, live
 * validation — and to show each node's mark. Null on the builder's canvas.
 */
export interface GraphPreview {
  marks: ReadonlyMap<string, PreviewMark>;
}

export const GraphPreviewContext = createContext<GraphPreview | null>(null);
