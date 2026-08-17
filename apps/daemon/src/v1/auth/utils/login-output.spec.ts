import { describe, expect, it } from 'vitest';

import {
  firstUrlIn,
  lastProgressLine,
  plainTerminalText,
} from './login-output';

describe('firstUrlIn', () => {
  it('finds the link claude prints, sentence and all', () => {
    // The real line, from `claude auth login` on 2.1.228 with stdin closed.
    const out =
      'Opening browser to sign in…\n' +
      "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c&scope=org%3Acreate_api_key+user%3Aprofile&state=abc\n" +
      'Paste code here if prompted > ';

    expect(firstUrlIn(out)).toBe(
      'https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c&scope=org%3Acreate_api_key+user%3Aprofile&state=abc',
    );
  });

  it('finds the link cursor prints, whose sentence is different', () => {
    // Same function, no per-CLI branch — which is the claim worth pinning, since
    // the two CLIs word the surrounding sentence differently and matching the
    // sentence is what would need a branch.
    const out =
      'Starting login process...\nAuthenticating with Cursor...\n' +
      'Waiting for browser authentication...\n' +
      'Open a browser and navigate to this link: https://cursor.com/loginDeepControl?challenge=l7tG&uuid=27b1&mode=login\n';

    expect(firstUrlIn(out)).toBe(
      'https://cursor.com/loginDeepControl?challenge=l7tG&uuid=27b1&mode=login',
    );
  });

  it('keeps a query string intact but drops trailing sentence punctuation', () => {
    // `&` and `=` must survive — a challenge truncated at the first `&` is a link
    // that loads and then fails, which is worse than no link. A trailing full
    // stop must not.
    expect(firstUrlIn('visit https://x.test/a?b=1&c=2.')).toBe(
      'https://x.test/a?b=1&c=2',
    );
  });

  it('returns null before the CLI has printed one', () => {
    expect(firstUrlIn('Starting login process...\n')).toBeNull();
    expect(firstUrlIn('')).toBeNull();
  });
});

describe('lastProgressLine', () => {
  it('never returns the URL line, however recent it is', () => {
    // The reason this filter exists: this string is shown in the UI and copied
    // into bug reports, and a login URL carries a live PKCE challenge. Deleting
    // the filter makes this test fail rather than merely changing wording.
    const out =
      'Authenticating with Cursor...\n' +
      'Open a browser and navigate to this link: https://cursor.com/login?challenge=secret\n';

    const line = lastProgressLine(out);

    expect(line).toBe('Authenticating with Cursor...');
    expect(line).not.toContain('challenge=secret');
  });

  it('keeps a prompt that arrived with no trailing newline', () => {
    // The most informative thing a stalled CLI has said is usually its prompt,
    // and a prompt is exactly what has no newline after it.
    expect(lastProgressLine('Opening browser…\nPaste code here > ')).toBe(
      'Paste code here >',
    );
  });

  it('is null when there is nothing but blank lines or a URL', () => {
    expect(lastProgressLine('\n  \n')).toBeNull();
    expect(lastProgressLine('https://x.test/only')).toBeNull();
  });
});

describe('plainTerminalText', () => {
  /**
   * What `claude mcp login` actually writes under a pty, transcribed from a
   * live run on 2.1.232: an EOT and two backspaces the wrapper echoes, CR line
   * endings, and the URL as an OSC-8 hyperlink whose target is repeated as the
   * visible text.
   */
  const PTY_OUTPUT =
    '\u0004\b\bStarting authentication for "probe"\u2026\r\n' +
    "If the browser didn't open, visit:\r\n" +
    '  \u001b]8;;https://tt.test/oauth?code_challenge=abc\u0007' +
    'https://tt.test/oauth?code_challenge=abc\u001b]8;;\u0007\r\n' +
    'Waiting for authorization\u2026 (^C to cancel)\r\n';

  it('leaves the URL exactly once, not glued to a copy of itself', () => {
    // The defect this function exists for, and it was observed END TO END: the
    // route answered with the authorization url immediately followed by a
    // second copy of the same url, because an OSC-8 hyperlink carries its
    // target inside the escape AND as the text after it.
    const url = firstUrlIn(plainTerminalText(PTY_OUTPUT));

    expect(url).toBe('https://tt.test/oauth?code_challenge=abc');
  });

  it('leaves no control character behind, so the answer is valid JSON', () => {
    // A raw control byte inside a JSON string is invalid JSON: the route
    // answered 200 with a body no client could parse, which is how this was
    // found. Newlines survive because the line readers need them.
    const text = plainTerminalText(PTY_OUTPUT);

    // Asserting on control characters is the whole point of this test.
    // eslint-disable-next-line no-control-regex
    expect(/[\u0000-\u0008\u000b-\u001f\u007f]/.test(text)).toBe(false);
    expect(() => JSON.parse(JSON.stringify({ text }))).not.toThrow();
  });

  it('reads the CLI’s last line as prose', () => {
    expect(lastProgressLine(plainTerminalText(PTY_OUTPUT))).toBe(
      'Waiting for authorization\u2026 (^C to cancel)',
    );
  });

  it('leaves prose from a piped child untouched', () => {
    // Applied unconditionally, so there is no second path to keep in step —
    // which is only safe if output that carries no escapes survives it.
    const plain = 'Opening browser to sign in\u2026\nPaste code here >';

    expect(plainTerminalText(plain)).toBe(plain);
  });
});
