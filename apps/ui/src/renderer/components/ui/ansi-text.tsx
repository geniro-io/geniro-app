import { Fragment } from 'react';

import { type AnsiColor, parseAnsi } from './ansi';
import { cn } from './utils';

/**
 * Command output, in the colours the command itself asked for.
 *
 * The ONE place a shell's escape sequences are drawn, so the terminal panel and
 * anything that later shows command output cannot disagree about what a red
 * line looks like. It is the reading half of {@link parseAnsi}: that decides
 * WHAT the bytes say, this decides what it looks like here.
 *
 * Every colour is a TOKEN (`--ansi-*` in `styles/themes/<id>.css`), never a
 * value from the stream. A terminal's own palette is built for a black
 * background and putting `#00ff00` on this cream card would be unreadable — so
 * the eight names are mapped to hues already proven on this surface, and the
 * mapping lives in the one file colours are allowed to live in.
 *
 * That is also the whole reason BRIGHT is resolved here as a class rather than
 * in the parser as a lightened value: what "brighter" should look like is a
 * fact about the THEME, and the two answer it differently. On the dark theme
 * all eight brights are genuinely lifted; on the light one only the greys move,
 * because a brighter ink on cream is a fainter one.
 */

/** The eight names, as the token classes that draw them. */
const COLOR_CLASS: Record<AnsiColor, string> = {
  black: 'text-ansi-black',
  red: 'text-ansi-red',
  green: 'text-ansi-green',
  yellow: 'text-ansi-yellow',
  blue: 'text-ansi-blue',
  magenta: 'text-ansi-magenta',
  cyan: 'text-ansi-cyan',
  white: 'text-ansi-white',
};

/** The same eight from the bright half of the range (90–97). */
const BRIGHT_COLOR_CLASS: Record<AnsiColor, string> = {
  black: 'text-ansi-bright-black',
  red: 'text-ansi-bright-red',
  green: 'text-ansi-bright-green',
  yellow: 'text-ansi-bright-yellow',
  blue: 'text-ansi-bright-blue',
  magenta: 'text-ansi-bright-magenta',
  cyan: 'text-ansi-bright-cyan',
  white: 'text-ansi-bright-white',
};

export function AnsiText({
  text,
  className,
}: {
  text: string;
  className?: string;
}): React.JSX.Element {
  const spans = parseAnsi(text);
  return (
    <>
      {spans.map((span, index) => {
        const styled =
          span.color !== null ||
          span.bold ||
          span.dim ||
          span.italic ||
          span.underline;
        if (!styled) {
          // A plain run is TEXT, not a span with no classes: most output is
          // uncoloured, and wrapping every line of it in an element for nothing
          // is a DOM the size of the log.
          return <Fragment key={index}>{span.text}</Fragment>;
        }
        return (
          <span
            // The index IS the identity here. These runs have no id of their
            // own, they are re-derived from the text on every poll, and the
            // list is append-only in practice — a keyed diff over a log would
            // be re-matching thousands of identical strings to save nothing.
            key={index}
            data-slot="ansi-span"
            data-ansi-color={span.color ?? undefined}
            data-ansi-bright={span.bright ? '' : undefined}
            className={cn(
              span.color !== null &&
                (span.bright
                  ? BRIGHT_COLOR_CLASS[span.color]
                  : COLOR_CLASS[span.color]),
              span.bold && 'font-bold',
              // `dim` is what a terminal draws at half intensity. Opacity
              // rather than a second set of muted tokens: it composes with all
              // eight colours, which is exactly what the code means.
              span.dim && 'opacity-60',
              span.italic && 'italic',
              span.underline && 'underline',
              className,
            )}>
            {span.text}
          </span>
        );
      })}
    </>
  );
}
