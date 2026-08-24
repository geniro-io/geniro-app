import { describe, expect, it } from 'vitest';

import { readCursorAgentFailure } from './cursor-agent-failure.utils';

describe('readCursorAgentFailure', () => {
  it('recognises the reported failure, and hands back the sentence alone', () => {
    // The screenshot this exists for, verbatim: the chunk the CLI writes from
    // its own catch block, which it then follows with `stopReason: end_turn`.
    expect(
      readCursorAgentFailure(
        '\n\nError: RetriableError: [unavailable] PING timed out',
      ),
    ).toBe('Error: RetriableError: [unavailable] PING timed out');
  });

  it('recognises the other three error classes the CLI can name', () => {
    // `String(e)` puts the class's own `get kind()` there — all four are real
    // classes in the shipped bundle, so a match on one is a match on any.
    for (const kind of [
      'NonRetriableError',
      'ActionRequiredError',
      'CancelledError',
    ]) {
      expect(readCursorAgentFailure(`\n\nError: ${kind}: it broke`)).toBe(
        `Error: ${kind}: it broke`,
      );
    }
  });

  it('recognises the auth arm, which carries no class name at all', () => {
    // Its own hardcoded string in the same catch block — the CLI substitutes a
    // sentence for a `connect` Unauthenticated code, so the bracketed code is
    // the only anchor left.
    const chunk =
      '\n\nError: [unauthenticated] Backend rejected authentication. Verify this is a User API Key for the same endpoint/environment, then rerun with --debug for request-level auth logs.';

    expect(readCursorAgentFailure(chunk)).toBe(chunk.trimStart());
  });

  it('recognises the four action sentences, which carry no prefix either', () => {
    for (const sentence of [
      'Please sign in to continue',
      'Upgrade your plan to continue',
      'Add a payment method to continue',
      'Check your settings to continue',
    ]) {
      expect(readCursorAgentFailure(`\n\n${sentence}`)).toBe(sentence);
    }
  });

  it('leaves an agent WRITING about an error alone', () => {
    // The commonest thing a coding agent says, and what both anchors exist to
    // survive: the word "error", a quoted class name, a pasted stack trace.
    // None of them opens a chunk as the CLI's own prefix plus a class name.
    for (const said of [
      'The build failed with an error — here is why.',
      'Error: the test suite is red',
      "I hit a `RetriableError` in the logs; let's retry.",
      '```\nError: RetriableError: [unavailable] PING timed out\n```',
      'Please sign in to continue is what the page says.',
    ]) {
      expect(readCursorAgentFailure(said)).toBeNull();
    }
  });

  it('says nothing about an empty or whitespace-only chunk', () => {
    expect(readCursorAgentFailure('')).toBeNull();
    expect(readCursorAgentFailure('\n\n  ')).toBeNull();
  });
});
