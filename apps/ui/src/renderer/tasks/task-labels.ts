import type { ProfileColor } from '../../shared/contracts';
import { PALETTE_DOT_CLASS } from '../components/ui/palette';

const PALETTE_KEYS = Object.keys(PALETTE_DOT_CLASS) as ProfileColor[];

/**
 * The colour a label wears, derived from its own text.
 *
 * A task's labels are bare strings — the daemon stores no colour for them — so
 * the alternative to deriving one is eight identical grey chips, which is the
 * thing that makes a board unreadable at a glance. Hashing the name means the
 * same label is the same colour on every card, in every project, across
 * restarts, with nothing to store or migrate.
 *
 * The hash is deliberately crude: this picks a swatch, and the only property
 * that matters is that it is stable and spreads. Two labels sharing a colour
 * costs nothing — the text is right beside the dot.
 */
export function labelColor(label: string): ProfileColor {
  let hash = 0;
  for (let i = 0; i < label.length; i += 1) {
    hash = (hash * 31 + label.charCodeAt(i)) % 1_000_003;
  }
  return PALETTE_KEYS[hash % PALETTE_KEYS.length] ?? 'blue';
}

/** The dot class for a label, ready to drop on a span. */
export function labelDotClass(label: string): string {
  return PALETTE_DOT_CLASS[labelColor(label)];
}

/**
 * A one-line plain-text preview of a markdown description.
 *
 * The first line that carries words, with the syntax that would render as
 * punctuation stripped — a card showing `## Context` or a bare ``` fence tells
 * the reader nothing, and rendering real markdown at card size is both slow and
 * illegible. The full text is one click away in the detail panel.
 */
export function descriptionPreview(description: string | null): string | null {
  if (description === null) {
    return null;
  }
  let heading: string | null = null;
  for (const raw of description.split('\n')) {
    const isHeading = /^\s{0,3}#{1,6}\s+/.test(raw);
    const line = plainText(raw);
    if (line === '') {
      continue;
    }
    // A heading names a SECTION, so it is the weaker answer: "Context" tells a
    // reader no more than "## Context" did. Prose wins when there is any, and
    // the first heading is kept only as the fallback for a description that is
    // nothing else.
    if (isHeading) {
      heading ??= line;
      continue;
    }
    return line;
  }
  return heading;
}

function plainText(raw: string): string {
  return raw
    .replace(/^\s{0,3}#{1,6}\s+/, '')
    .replace(/^\s*[-*+]\s+\[[ xX]\]\s+/, '')
    .replace(/^\s*[-*+]\s+/, '')
    .replace(/^\s*>\s?/, '')
    .replace(/`{1,3}/g, '')
    .replace(/[*_]{1,2}/g, '')
    .trim();
}
