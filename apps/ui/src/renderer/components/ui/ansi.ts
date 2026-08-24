/**
 * A shell's own escape sequences, read into styled runs of text.
 *
 * Command output is not plain text: anything a developer runs routinely emits
 * SGR colour codes (`git --color=always`, `pytest --color=yes`, every tool that
 * sees `FORCE_COLOR`), and progress output redraws its line with carriage
 * returns and cursor moves. Rendered verbatim, the escape byte itself is
 * invisible in HTML and what reaches the screen is its tail — `[32mok[0m` —
 * so a coloured log reads as corrupted rather than as coloured.
 *
 * A PURE parser, separate from the component that draws it, so the whole of
 * this — which sequences are understood, which are dropped, what a `\r` does —
 * is testable without a DOM.
 *
 * DELIBERATELY PARTIAL, and the omissions are listed at their branches: this
 * renders a log, it does not emulate a terminal. There is no screen buffer, so
 * cursor moves cannot be honoured; there are no background colours, because a
 * per-span fill on a cream card is noise rather than information; and an
 * arbitrary 24-bit colour cannot be shown at all under the renderer's own rule
 * that a colour comes from a token (`renderer-design-system.md`).
 */

/** The eight colours a shell can name. */
export type AnsiColor =
  'black' | 'red' | 'green' | 'yellow' | 'blue' | 'magenta' | 'cyan' | 'white';

/** One run of text under one set of attributes. */
export interface AnsiSpan {
  text: string;
  /** Null is the surface's own colour — no `text-*` class is applied. */
  color: AnsiColor | null;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
}

const COLORS: readonly AnsiColor[] = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
];

/**
 * Every escape sequence, not merely the ones that mean something.
 *
 * Three alternatives, because all three appear in real logs and only the first
 * carries style: a CSI sequence (`ESC [ … final`, of which `m` is SGR and the
 * rest are cursor and erase commands), an OSC string (`ESC ] … BEL`, how a tool
 * sets the window title), and a bare two-character escape. Matching them all in
 * ONE pass is what keeps the unhandled ones from reaching the screen as text —
 * dropping only the sequences that are understood would leave `[2K` visible on
 * every line a spinner redrew.
 */
const ESCAPE =
  // Every control byte here is written as a `\u….` ESCAPE rather than as
  // itself, and that is this repo's rule rather than a style: a raw control
  // byte in a `.ts` file is invisible in a diff, in a review comment and in a
  // grep, and the pre-commit hook refuses a blob git decides is binary. The
  // escape and the byte are the identical code unit at runtime.
  //
  // eslint-disable-next-line no-control-regex -- matching them IS the module
  /\u001b(?:\[([0-9;:?]*)([ -/]*[@-~])|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\-_])/g;

/** The attributes in force at a point in the stream. */
interface AnsiState {
  color: AnsiColor | null;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
}

const CLEAR: AnsiState = {
  color: null,
  bold: false,
  dim: false,
  italic: false,
  underline: false,
};

/**
 * Apply one SGR sequence's parameters to the running state.
 *
 * Parameters are applied IN ORDER and each is independent — `ESC[1;31m` is bold
 * then red — which is why this walks the list rather than switching on the
 * whole string. An empty parameter list is a reset, as `ESC[m` means.
 */
function applySgr(state: AnsiState, params: string): AnsiState {
  const codes = params === '' ? [0] : params.split(';').map((p) => Number(p));
  let next = state;
  for (let i = 0; i < codes.length; i += 1) {
    const code = codes[i];
    if (code === undefined || Number.isNaN(code)) {
      continue;
    }
    if (code === 0) {
      next = CLEAR;
    } else if (code === 1) {
      next = { ...next, bold: true };
    } else if (code === 2) {
      next = { ...next, dim: true };
    } else if (code === 3) {
      next = { ...next, italic: true };
    } else if (code === 4) {
      next = { ...next, underline: true };
    } else if (code === 21 || code === 22) {
      next = { ...next, bold: false, dim: false };
    } else if (code === 23) {
      next = { ...next, italic: false };
    } else if (code === 24) {
      next = { ...next, underline: false };
    } else if (code >= 30 && code <= 37) {
      next = { ...next, color: COLORS[code - 30] ?? null };
    } else if (code === 39) {
      next = { ...next, color: null };
    } else if (code >= 90 && code <= 97) {
      // The bright half maps to the same eight: see the palette's own note —
      // on a light background a brighter ink is a fainter one.
      next = { ...next, color: COLORS[code - 90] ?? null };
    } else if (code === 38) {
      // An extended colour, whose own parameters follow: `5;N` (the 256-colour
      // palette) or `2;R;G;B` (24-bit). Only the first sixteen of the 256 are
      // the named colours, and everything past them — the 216-colour cube, the
      // greys, and every truecolour — has no token to be drawn in, so it takes
      // the surface's colour rather than an invented one. The parameters are
      // still CONSUMED either way, or their digits print as text.
      const mode = codes[i + 1];
      if (mode === 5) {
        const index = codes[i + 2];
        next = {
          ...next,
          color:
            index !== undefined && index >= 0 && index < 16
              ? (COLORS[index % 8] ?? null)
              : null,
        };
        i += 2;
      } else if (mode === 2) {
        next = { ...next, color: null };
        i += 4;
      }
    }
    // Everything else — backgrounds (40–49, 100–107), reverse video, blink,
    // conceal, fonts — is READ and dropped. They are legal and they say nothing
    // this surface can honour; see the module note.
  }
  return next;
}

/**
 * What a line looks like after its carriage returns have been played out.
 *
 * A progress bar writes `10%\r20%\r30%` into one line and a terminal shows the
 * last of them; joined as text it reads as all three at once. Only the final
 * segment survives, which is what a reader would have seen — measured against
 * real `pnpm`/`vite` output, where the alternative is one unreadable line per
 * spinner tick.
 *
 * A trailing `\r` (the redraw that had nothing after it) leaves the line as it
 * stood, not empty.
 */
function playCarriageReturns(line: string): string {
  if (!line.includes('\r')) {
    return line;
  }
  const segments = line.split('\r').filter((segment) => segment !== '');
  return segments.length === 0 ? '' : (segments[segments.length - 1] ?? '');
}

/**
 * Read text carrying escape sequences into styled spans.
 *
 * Adjacent runs under identical attributes are merged, so a stream that resets
 * its colour between every word produces one span rather than a hundred.
 */
export function parseAnsi(text: string): AnsiSpan[] {
  // `\r\n` is a line ending, not a redraw — split it off before the redraw rule
  // below, or every CRLF log loses its every line but the last.
  const normalized = text.replace(/\r\n/g, '\n');
  const played = normalized.split('\n').map(playCarriageReturns).join('\n');
  const spans: AnsiSpan[] = [];
  let state = CLEAR;
  let index = 0;
  const push = (chunk: string): void => {
    if (chunk === '') {
      return;
    }
    const last = spans[spans.length - 1];
    if (
      last !== undefined &&
      last.color === state.color &&
      last.bold === state.bold &&
      last.dim === state.dim &&
      last.italic === state.italic &&
      last.underline === state.underline
    ) {
      last.text += chunk;
      return;
    }
    spans.push({ text: chunk, ...state });
  };
  ESCAPE.lastIndex = 0;
  let match = ESCAPE.exec(played);
  while (match !== null) {
    push(played.slice(index, match.index));
    if (match[2] === 'm') {
      state = applySgr(state, match[1] ?? '');
    }
    index = match.index + match[0].length;
    match = ESCAPE.exec(played);
  }
  push(played.slice(index));
  return spans;
}

/**
 * The same text with every escape sequence removed — what a reader would copy.
 *
 * Exported because the styled spans are for the EYE: a copy control must hand
 * over the characters, not the codes that coloured them.
 */
export function stripAnsi(text: string): string {
  return parseAnsi(text)
    .map((span) => span.text)
    .join('');
}
