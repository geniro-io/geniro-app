import {
  type GalleryDownloadFailure,
  type HostGallery,
  type HostGalleryImage,
  type HostGalleryOutcome,
  MAX_GALLERY_CAPTION_LENGTH,
  MAX_GALLERY_DESCRIPTION_LENGTH,
  MAX_GALLERY_IMAGES,
  MAX_GALLERY_PATH_LENGTH,
  MAX_GALLERY_TITLE_LENGTH,
} from '../../../agents/chat.types';

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
 * where the read actually happens. A URL is judged where it is downloaded.
 *
 * A path is TRUNCATED to its cap like every other string in the family, which
 * is safe for exactly the same reason: a cut path names a different file or no
 * file, and the route answers accordingly. It cannot be made to name a file
 * outside what an untruncated path could already reach.
 *
 * `source` is never read from the call: it records where the daemon itself
 * downloaded a picture from.
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
  // `path` is the documented name; `src` and `url` are what a model writing
  // HTML or holding a link reaches for, and accepting them costs one `??`
  // against a whole gallery dropped over a synonym.
  const path =
    text(entry.path, MAX_GALLERY_PATH_LENGTH) ??
    text(entry.src, MAX_GALLERY_PATH_LENGTH) ??
    text(entry.url, MAX_GALLERY_PATH_LENGTH);
  if (path === null) {
    return null;
  }
  const caption = text(entry.caption, MAX_GALLERY_CAPTION_LENGTH);
  const description = text(entry.description, MAX_GALLERY_DESCRIPTION_LENGTH);
  return {
    path,
    ...(caption === null ? {} : { caption }),
    ...(description === null ? {} : { description }),
  };
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
 * echoing the list here would put every path in it twice. The one exception is
 * a URL that could not be downloaded: the agent is told which and why, since
 * that picture is missing from what the user sees.
 *
 * The count is said because the cap truncates silently: an agent that sent
 * thirty images reads back twenty-four and knows.
 */
export function hostGalleryResultText(
  outcome: HostGalleryOutcome,
  failures: readonly GalleryDownloadFailure[] = [],
): string {
  const failed =
    failures.length === 0
      ? ''
      : ` ${failures.length} ${failures.length === 1 ? 'image' : 'images'} could not be downloaded: ${failures
          .map((failure) => `${failure.url} (${failure.reason})`)
          .join('; ')}.`;
  if (outcome.status === 'unavailable') {
    return `The gallery could not be shown (${outcome.reason}).${failed} Describe the images in your reply instead.`;
  }
  const noun = outcome.images === 1 ? 'image' : 'images';
  return `Gallery shown to the user: ${outcome.images} ${noun}.${failed}`;
}
