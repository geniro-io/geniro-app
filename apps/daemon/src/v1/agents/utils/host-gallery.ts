import {
  HOST_GALLERY_TOOL,
  type HostGallery,
  type HostGalleryImage,
  type HostGalleryOutcome,
  MAX_GALLERY_CAPTION_LENGTH,
  MAX_GALLERY_IMAGES,
  MAX_GALLERY_PATH_LENGTH,
  MAX_GALLERY_TITLE_LENGTH,
} from '../chat.types';
import { isHostToolCall } from './host-tool';

/**
 * Whether a permission request names geniro's OWN gallery tool.
 *
 * Auto-approved on the family's reading: what the agent is asking to run is the
 * act of DRAWING in this app's own transcript. The pictures are read by the
 * RENDERER afterwards, through the image route's own guards, so nothing this
 * call does reaches the disk and a card guarding it would fire on every gallery
 * to protect nothing.
 *
 * How the pair is matched belongs to {@link isHostToolCall}.
 */
export function isHostGalleryCall(
  serverName: string | null,
  toolName: string,
): boolean {
  return isHostToolCall(serverName, toolName, HOST_GALLERY_TOOL);
}

/** Trim to a cap without inventing content; an absent value stays absent. */
function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed.slice(0, max);
}

/**
 * One image entry, or null when it names no file.
 *
 * A bare string is accepted alongside the object form. A list of paths is the
 * shape a model reaches for when it has nothing to caption, and refusing it
 * would answer the commonest call with "malformed".
 *
 * The path is NOT canonicalized, resolved or checked here, and that is
 * deliberate rather than an omission: this process does not read the file. The
 * renderer asks the image route for it, and that route owns the guards —
 * checking here as well would be a second, drifting copy of a decision made
 * where the read actually happens.
 *
 * A path is TRUNCATED to its cap like every other string in the family, which
 * is safe for exactly the same reason: a cut path names a different file or no
 * file, and the route answers accordingly. It cannot be made to name a file
 * outside what an untruncated path could already reach.
 */
function galleryImage(value: unknown): HostGalleryImage | null {
  if (typeof value === 'string') {
    const path = text(value, MAX_GALLERY_PATH_LENGTH);
    return path === null ? null : { path };
  }
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const entry = value as Record<string, unknown>;
  // `path` is the documented name; `src` is what a model writing HTML in its
  // head reaches for, and accepting it costs one `??` against a whole gallery
  // dropped over a synonym.
  const path =
    text(entry.path, MAX_GALLERY_PATH_LENGTH) ??
    text(entry.src, MAX_GALLERY_PATH_LENGTH);
  if (path === null) {
    return null;
  }
  const caption = text(entry.caption, MAX_GALLERY_CAPTION_LENGTH);
  return { path, ...(caption === null ? {} : { caption }) };
}

/**
 * Read a `show_gallery` tool call's arguments into the gallery the card draws,
 * or null when the payload names no picture at all.
 *
 * Defensive rather than schema-validating, on the rule every host tool's reader
 * follows: the caller is a model, so a field can be anything, and the honest
 * answers are "here is what parsed" and "none of it did" — never a throw across
 * the transport.
 *
 * Unreadable entries are DROPPED here, where {@link readHostChart} blanks them.
 * The two are not inconsistent: a chart's cells are positional, so removing one
 * silently re-attributes every measurement after it, while a gallery is a SET
 * and a tile that names no file is a tile with nothing to draw. The count in
 * the receipt is what tells the agent some did not survive.
 */
export function readHostGallery(
  args: Record<string, unknown>,
): HostGallery | null {
  const raw = args.images;
  if (!Array.isArray(raw)) {
    return null;
  }
  // The cap counts what SURVIVES, not what was sent: slicing first would let a
  // call whose opening entries are malformed answer "no image to show" while
  // naming perfectly good files below them.
  const images: HostGalleryImage[] = [];
  for (const entry of raw) {
    if (images.length === MAX_GALLERY_IMAGES) {
      break;
    }
    const image = galleryImage(entry);
    if (image !== null) {
      images.push(image);
    }
  }
  if (images.length === 0) {
    return null;
  }
  const title = text(args.title, MAX_GALLERY_TITLE_LENGTH);
  return { images, ...(title === null ? {} : { title }) };
}

/**
 * The tool result text for one outcome.
 *
 * A RECEIPT, never the paths — the point of a host-drawn gallery is that the
 * pictures go to the screen instead of back through the model's window, and
 * echoing the list here would put every path in it twice.
 *
 * The count is said because the cap truncates silently: an agent that sent
 * thirty images reads back twenty-four and knows.
 */
export function hostGalleryResultText(outcome: HostGalleryOutcome): string {
  if (outcome.status === 'unavailable') {
    return `The gallery could not be shown (${outcome.reason}). Describe the images in your reply instead.`;
  }
  const noun = outcome.images === 1 ? 'image' : 'images';
  return `Gallery shown to the user: ${outcome.images} ${noun}.`;
}
