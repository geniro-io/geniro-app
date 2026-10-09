/**
 * The folder, under an artifact, that holds its pictures. A stored page points at
 * a picture as `images/<name>`, and the store that writes the pictures and the
 * renderer that inlines them both need that spelling, so it is named once here.
 */
export const ARTIFACT_IMAGES_DIR = 'images';

/**
 * The formats a stored picture may be in, by file extension. Named beside the
 * reference grammar so the store, the policy that sniffs the bytes and the page
 * renderer that recognises a stored reference all draw from one list.
 */
export const ARTIFACT_IMAGE_EXTENSIONS = [
  'png',
  'jpg',
  'webp',
  'gif',
  'avif',
] as const;

export type ArtifactImageExtension = (typeof ARTIFACT_IMAGE_EXTENSIONS)[number];

export type ArtifactImageMediaType =
  'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' | 'image/avif';

/** The media type each stored image is served under, by its extension. */
export const ARTIFACT_IMAGE_MEDIA_TYPE: Record<
  ArtifactImageExtension,
  ArtifactImageMediaType
> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif',
};

/** Whether a file extension is one of the formats a stored picture may be in. */
export function isArtifactImageExtension(
  value: string,
): value is ArtifactImageExtension {
  return (ARTIFACT_IMAGE_EXTENSIONS as readonly string[]).includes(value);
}

/**
 * The file name a stored picture is kept under: the hash of its bytes, then its
 * extension. Anything else is not one of the store's pictures, which is what keeps
 * the image route from being a way to name an arbitrary file.
 */
export const ARTIFACT_IMAGE_FILE = new RegExp(
  `^[0-9a-f]{64}\\.(${ARTIFACT_IMAGE_EXTENSIONS.join('|')})$`,
);

/**
 * The start of an image tag: `<img` whose tag name ends there, which a browser reads
 * as ending at whitespace, a slash or a `>`. So `<imgx` and `<img-x` are other tags.
 */
const IMG_OPEN = /<img(?=[ \t\n\f\r/>]|$)/gi;

/** The characters a browser treats as whitespace inside a tag. */
function isSpace(character: string | undefined): boolean {
  return (
    character === ' ' ||
    character === '\t' ||
    character === '\n' ||
    character === '\f' ||
    character === '\r'
  );
}

/** One attribute of a start tag, with where it stands in the page. */
interface TagAttribute {
  /** The name as written. */
  readonly name: string;
  /** The index of the name's first character. */
  readonly start: number;
  /** The index just past the attribute: past its closing quote, or past a bare value. */
  readonly end: number;
  /** The value, or null for an attribute written without `=`. */
  readonly value: string | null;
  /** The quote the value is written in: `"`, `'`, or empty for a bare value. */
  readonly quote: '"' | "'" | '';
}

/** A start tag read to its `>`: `end` is the index just past it. */
interface StartTag {
  readonly end: number;
  readonly attributes: readonly TagAttribute[];
}

/**
 * The start tag whose `<` sits at `open`, read the way a browser reads one: a quoted
 * value runs to its closing quote, so a `>` inside it is part of the value, and an
 * unquoted value runs to whitespace or `>`, so a quote inside it is a plain
 * character. Null when the tag is never closed. A browser drops everything from such
 * a tag to the end of the page, so nothing after it is a picture.
 *
 * Each character is read once, which keeps a page of many tags linear. The earlier
 * pattern restarted its scan at every `<img`, so a page of unclosed ones cost time
 * that grew with the square of its length, on the daemon's one thread.
 */
function readStartTag(html: string, open: number): StartTag | null {
  const attributes: TagAttribute[] = [];
  let i = open + '<img'.length;
  for (;;) {
    while (i < html.length && (isSpace(html[i]) || html[i] === '/')) {
      i += 1;
    }
    if (i >= html.length) {
      return null;
    }
    if (html[i] === '>') {
      return { end: i + 1, attributes };
    }
    const start = i;
    // The first character belongs to the name even when it is `=`, as a browser reads it.
    i += 1;
    while (
      i < html.length &&
      !isSpace(html[i]) &&
      html[i] !== '/' &&
      html[i] !== '>' &&
      html[i] !== '='
    ) {
      i += 1;
    }
    const name = html.slice(start, i);
    let equals = i;
    while (equals < html.length && isSpace(html[equals])) {
      equals += 1;
    }
    if (html[equals] !== '=') {
      attributes.push({ name, start, end: i, value: null, quote: '' });
      continue;
    }
    i = equals + 1;
    while (i < html.length && isSpace(html[i])) {
      i += 1;
    }
    const opener = html[i];
    if (opener === '"' || opener === "'") {
      const close = html.indexOf(opener, i + 1);
      if (close === -1) {
        return null;
      }
      attributes.push({
        name,
        start,
        end: close + 1,
        value: html.slice(i + 1, close),
        quote: opener,
      });
      i = close + 1;
      continue;
    }
    let valueEnd = i;
    while (
      valueEnd < html.length &&
      !isSpace(html[valueEnd]) &&
      html[valueEnd] !== '>'
    ) {
      valueEnd += 1;
    }
    attributes.push({
      name,
      start,
      end: valueEnd,
      value: html.slice(i, valueEnd),
      quote: '',
    });
    i = valueEnd;
  }
}

/**
 * The tag's `src`, when it has one with a value. A browser reads the FIRST `src`
 * only, so a later duplicate is never the picture shown, and a first `src` written
 * without a value shows nothing, so it is not rewritten either.
 */
function sourceOf(tag: StartTag): TagAttribute | null {
  const first = tag.attributes.find(
    (attribute) => attribute.name.toLowerCase() === 'src',
  );
  return first !== undefined && first.value !== null ? first : null;
}

/**
 * A source value written back in the quote it was read in. A bare value is written
 * bare only while a browser would read it back unchanged; otherwise it is quoted.
 */
function writeSourceValue(value: string, quote: '"' | "'" | ''): string {
  if (quote !== '') {
    return `${quote}${value}${quote}`;
  }
  return /^[^\s"'<>=`]+$/.test(value) ? value : `"${value}"`;
}

/**
 * The text of one tag from `open` to `tag.end`, with its `src` replaced by what `map`
 * returns for it. The tag is returned as it was when the mapping keeps the source.
 */
function rewriteTag(
  html: string,
  open: number,
  tag: StartTag,
  map: (src: string) => string,
): string {
  const source = sourceOf(tag);
  const tagText = html.slice(open, tag.end);
  if (source === null || source.value === null) {
    return tagText;
  }
  const mapped = map(source.value);
  if (mapped === source.value) {
    return tagText;
  }
  return `${html.slice(open, source.start)}${source.name}=${writeSourceValue(mapped, source.quote)}${html.slice(source.end, tag.end)}`;
}

/**
 * Every `<img>` source in a page, passed through `map`, which returns what the
 * source should say instead. Nothing else is touched: the other attributes, the
 * quoting of a source that is not changed, and every byte outside an image tag are
 * written back exactly as they were. A tag that is never closed ends the page's
 * image tags, as it does in a browser.
 */
export function mapImageSources(
  html: string,
  map: (src: string) => string,
): string {
  // A fresh pattern per call: `exec` keeps its place in the pattern it is given.
  const opens = new RegExp(IMG_OPEN.source, IMG_OPEN.flags);
  let out = '';
  let copied = 0;
  for (let match = opens.exec(html); match !== null; match = opens.exec(html)) {
    const tag = readStartTag(html, match.index);
    if (tag === null) {
      break;
    }
    out +=
      html.slice(copied, match.index) + rewriteTag(html, match.index, tag, map);
    copied = tag.end;
    opens.lastIndex = tag.end;
  }
  return out + html.slice(copied);
}

/**
 * Whether an image source names a file on this machine, and so belongs to the
 * image policy. A source in another scheme (`data:`, `https:`, `blob:`) or a
 * protocol-relative host (`//cdn…`) is left to the browser, and so is an empty one.
 * A `file:` address IS a file on this machine. A bare `#fragment` or `?query`
 * names the page itself, not a picture, and is left as written.
 *
 * Any other relative path is local on purpose: it then fails the policy's
 * absolute-path check with a reason the agent can act on, where leaving it alone
 * would ship a broken picture with no word about why.
 */
export function isLocalImageSource(src: string): boolean {
  const trimmed = src.trim();
  if (
    trimmed === '' ||
    trimmed.startsWith('#') ||
    trimmed.startsWith('?') ||
    trimmed.startsWith('//')
  ) {
    return false;
  }
  if (/^file:/i.test(trimmed)) {
    return true;
  }
  return !/^[a-z][a-z0-9+.-]*:/i.test(trimmed);
}
