import { createElement, Fragment, type ReactNode } from 'react';

import { codePointName, hazardHitLabel, hiddenCharHits } from './text-hazards';

const LINE_CONTROLS = new Set([0x09, 0x0a, 0x0d]);

/**
 * `text` with every character that draws as nothing or reorders the line
 * shown as a visible `<U+XXXX>` mark instead, so code reads as it is stored.
 * Tabs and line breaks stay as they are.
 */
export function markHiddenChars(text: string): ReactNode {
  const hits = hiddenCharHits(text).filter(
    (hit) => !LINE_CONTROLS.has(hit.codePoint),
  );
  if (hits.length === 0) {
    return text;
  }
  const parts: ReactNode[] = [];
  let at = 0;
  for (const hit of hits) {
    if (hit.offset > at) {
      parts.push(text.slice(at, hit.offset));
    }
    const name = codePointName(hit.codePoint);
    parts.push(
      createElement(
        'span',
        {
          key: hit.offset,
          'data-hidden-char': name,
          title: hazardHitLabel(hit),
          className:
            'mx-px rounded-sm bg-warning/20 px-0.5 text-[0.85em] text-warning select-none',
        },
        `<${name}>`,
      ),
    );
    at = hit.offset + String.fromCodePoint(hit.codePoint).length;
  }
  parts.push(text.slice(at));
  return createElement(Fragment, null, ...parts);
}
