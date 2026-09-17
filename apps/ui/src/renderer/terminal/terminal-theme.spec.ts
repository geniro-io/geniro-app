// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

import { readTerminalFont, readTerminalTheme } from './terminal-theme';

afterEach(() => {
  document.documentElement.removeAttribute('style');
  document.body.innerHTML = '';
});

describe('readTerminalTheme', () => {
  it('takes the ground and ink from its host, and the palette from the ansi tokens', () => {
    const root = document.documentElement.style;
    root.setProperty('--ansi-red', 'rgb(200, 0, 0)');
    root.setProperty('--ansi-bright-red', 'rgb(255, 80, 80)');
    root.setProperty('--ansi-bright-black', 'rgb(90, 90, 90)');
    root.setProperty('--foreground', 'rgb(10, 10, 10)');
    const host = document.createElement('div');
    host.style.backgroundColor = 'rgb(250, 250, 240)';
    host.style.color = 'rgb(20, 20, 20)';
    document.body.appendChild(host);

    const theme = readTerminalTheme(host);

    expect(theme).toMatchObject({
      background: 'rgb(250, 250, 240)',
      foreground: 'rgb(20, 20, 20)',
      cursor: 'rgb(10, 10, 10)',
      red: 'rgb(200, 0, 0)',
      brightRed: 'rgb(255, 80, 80)',
      brightBlack: 'rgb(90, 90, 90)',
    });
  });

  it('leaves a colour unset rather than empty when its token is missing', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);

    const theme = readTerminalTheme(host);

    // An empty string would paint nothing; undefined keeps xterm's own default.
    expect(theme.green).toBeUndefined();
    expect(theme.brightGreen).toBeUndefined();
  });
});

describe('readTerminalFont', () => {
  it('uses the app’s mono stack', () => {
    document.documentElement.style.setProperty(
      '--font-family-mono',
      'ui-monospace, Menlo',
    );

    expect(readTerminalFont()).toBe('ui-monospace, Menlo');
  });
});
