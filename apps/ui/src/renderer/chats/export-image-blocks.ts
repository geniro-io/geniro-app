/**
 * Base64 image blocks, collapsed to a line saying what they were.
 *
 * A markdown export JSON-dumps any payload it has no prose form for, and a tool
 * result carrying a screenshot is one of those — so the bytes the agent looked at
 * are written out in full. MEASURED on one real export of a workflow run:
 * **13.8 MB of a 28.9 MB file** was 81 such blocks, none of which a reader can do
 * anything with. Analysing that export meant writing a parser, because no editor
 * or diff tool will open a 28.9 MB file with single lines megabytes long.
 *
 * What replaces a block is a line naming its type and its SIZE — `[image:
 * image/png, 171 KB]` — which is exactly what a reader wants from it: that the
 * agent saw a picture there, and roughly how big it was. The bytes are not lost
 * to the app either way; the transcript still holds them and the viewer still
 * opens them.
 *
 * It walks the whole payload rather than knowing where a CLI puts its images: the
 * two shapes below are the ones both shipped transports produce, and the walk is
 * what makes a third one the caller's problem rather than this module's.
 */

/** A base64 payload shorter than this is left alone — see {@link collapseImageBlocks}. */
const MIN_COLLAPSED_BASE64 = 512;

/** How deep the walk goes before it stops — a payload is not a tree of trees. */
const MAX_DEPTH = 12;

/**
 * Read an image block's media type and base64 data, or null when this object is
 * not one.
 *
 * TWO shapes, and both are measured rather than guessed:
 *
 * - `{type: 'image', source: {type: 'base64', data, media_type}}` — claude's own
 *   content block, verbatim out of a real export (`"media_type": "image/png"`).
 *   It is what `claude-images.utils.ts` writes into that CLI's stdin, so it comes
 *   back on a tool result in the same shape.
 * - `{type: 'image', mimeType, data}` — the ACP `image` content block
 *   (`acp-content.ts`), which is how the cursor transport carries one.
 *
 * `type: 'image'` is required in both. A bare long string under a key called
 * `data` is deliberately NOT collapsed: a base64 blob that nothing has declared
 * to be an image could be anything, and a reader who loses it has lost the only
 * copy in the file.
 */
function readImageBlock(
  value: Record<string, unknown>,
): { mediaType: string; data: string } | null {
  if (value.type !== 'image') {
    return null;
  }
  const source = value.source;
  if (source !== null && typeof source === 'object') {
    const inner = source as Record<string, unknown>;
    if (typeof inner.data === 'string') {
      return {
        mediaType:
          typeof inner.media_type === 'string' ? inner.media_type : 'image',
        data: inner.data,
      };
    }
  }
  if (typeof value.data === 'string') {
    return {
      mediaType: typeof value.mimeType === 'string' ? value.mimeType : 'image',
      data: value.data,
    };
  }
  return null;
}

/**
 * The line a collapsed block becomes.
 *
 * Kilobytes of the DECODED bytes, not of the base64, because that is the size of
 * the picture and the figure a reader would compare against a file on disk;
 * base64 is 4 characters per 3 bytes. Rounded to a whole KB — a screenshot is
 * hundreds of them, and a decimal here says nothing.
 */
function describeImage(mediaType: string, data: string): string {
  const bytes = Math.floor((data.length * 3) / 4);
  return `[image: ${mediaType}, ${Math.max(1, Math.round(bytes / 1024))} KB]`;
}

/**
 * Replace every base64 image block inside `value` with {@link describeImage}'s
 * line, leaving everything else exactly as it was.
 *
 * Returns the ORIGINAL value when nothing matched, so the common case — every
 * payload that holds no image — allocates nothing and the export is unchanged
 * byte for byte.
 *
 * A block whose data is shorter than {@link MIN_COLLAPSED_BASE64} is left alone:
 * the whole point is the megabytes, and a tiny inline icon is more useful as
 * itself than as a line claiming it was 0 KB.
 */
export function collapseImageBlocks(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== 'object' || depth > MAX_DEPTH) {
    return value;
  }
  if (Array.isArray(value)) {
    let changed = false;
    const mapped = value.map((entry) => {
      const next = collapseImageBlocks(entry, depth + 1);
      changed = changed || next !== entry;
      return next;
    });
    return changed ? mapped : value;
  }
  const record = value as Record<string, unknown>;
  const image = readImageBlock(record);
  if (image !== null && image.data.length >= MIN_COLLAPSED_BASE64) {
    return describeImage(image.mediaType, image.data);
  }
  let changed = false;
  const mapped: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    const next = collapseImageBlocks(entry, depth + 1);
    changed = changed || next !== entry;
    mapped[key] = next;
  }
  return changed ? mapped : value;
}
