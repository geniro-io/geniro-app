import { afterEach, describe, expect, it } from 'vitest';

import { clearSecrets, redactSecrets, registerSecret } from './redact';

afterEach(() => clearSecrets());

/** A realistic launch token — 64 hex chars, as `mintToken` produces. */
const TOKEN = 'a'.repeat(32) + 'b'.repeat(32);

describe('redactSecrets', () => {
  it('replaces a registered secret with its label', () => {
    registerSecret(TOKEN, 'launch token');

    const out = redactSecrets(`authorization: Bearer ${TOKEN}`);

    expect(out).not.toContain(TOKEN);
    expect(out).toContain('launch token redacted');
    // The line around it SURVIVES. A redaction that ate the whole message
    // would protect the token by destroying the evidence it sat in.
    expect(out).toContain('authorization: Bearer');
  });

  it('replaces EVERY occurrence, not just the first', () => {
    // A single turn's log routinely repeats a token — argv, a URL, a header.
    // Leaving the second one is the same leak as leaving the first.
    registerSecret(TOKEN, 'launch token');

    const out = redactSecrets(`${TOKEN} ... ${TOKEN} ... ${TOKEN}`);

    expect(out).not.toContain(TOKEN);
    expect(out.match(/launch token redacted/g)).toHaveLength(3);
  });

  it('masks the LONGEST match when one secret contains another', () => {
    // The call token is embedded in the MCP endpoint URL the daemon writes.
    // Registered shortest-first, the inner one would be replaced and leave the
    // URL half-scrubbed — labelled as the wrong thing and still identifying.
    registerSecret(TOKEN, 'launch token');
    registerSecret(`http://127.0.0.1:47615/v1/mcp/${TOKEN}`, 'mcp endpoint');

    const out = redactSecrets(`GET http://127.0.0.1:47615/v1/mcp/${TOKEN} ok`);

    expect(out).toContain('mcp endpoint redacted');
    expect(out).not.toContain('launch token redacted');
    expect(out).not.toContain(TOKEN);
  });

  it('ignores a value too short to be a credential', () => {
    // Redacting "abc" out of every line destroys the log to protect nothing —
    // and every real credential here is far longer.
    registerSecret('abc', 'tiny');

    expect(redactSecrets('abc def abcdef')).toBe('abc def abcdef');
  });

  it('ignores empty and absent values', () => {
    registerSecret('', 'empty');
    registerSecret(null, 'null');
    registerSecret(undefined, 'undefined');

    expect(redactSecrets('nothing to do here')).toBe('nothing to do here');
  });

  it('registers a value once, however many times it is offered', () => {
    // Boot paths run more than once in tests, and a duplicate would only cost
    // a redundant pass — but the count is what the report shows.
    registerSecret(TOKEN, 'launch token');
    registerSecret(TOKEN, 'launch token');

    expect(redactSecrets(TOKEN)).toBe('‹launch token redacted›');
  });

  it('leaves text alone when nothing is registered', () => {
    expect(redactSecrets(`bearer ${TOKEN}`)).toContain(TOKEN);
  });
});
