import type { ITheme } from '@xterm/xterm';

const ANSI_NAMES = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
] as const;

type AnsiName = (typeof ANSI_NAMES)[number];
type BrightName = `bright${Capitalize<AnsiName>}`;

/**
 * xterm paints on a canvas-like surface and takes concrete colour VALUES, not
 * class names — so they are read off the same tokens every other surface uses:
 * the ground and ink of the element the terminal sits in, and the `--ansi-*`
 * palette `ansi-text` draws command output with. Re-read on a theme change.
 */
export function readTerminalTheme(host: HTMLElement): ITheme {
  const root = getComputedStyle(document.documentElement);
  const token = (name: string): string | undefined =>
    root.getPropertyValue(`--${name}`).trim() || undefined;
  const surface = getComputedStyle(host);
  const theme: ITheme = {
    background: surface.backgroundColor || undefined,
    foreground: surface.color || undefined,
    cursor: token('foreground'),
    cursorAccent: surface.backgroundColor || undefined,
    selectionBackground: token('accent'),
  };
  for (const name of ANSI_NAMES) {
    theme[name] = token(`ansi-${name}`);
    const bright =
      `bright${name[0]!.toUpperCase()}${name.slice(1)}` as BrightName;
    theme[bright] = token(`ansi-bright-${name}`);
  }
  return theme;
}

/** The mono stack the rest of the app's code surfaces use. */
export function readTerminalFont(): string | undefined {
  return (
    getComputedStyle(document.documentElement)
      .getPropertyValue('--font-family-mono')
      .trim() || undefined
  );
}
