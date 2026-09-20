import { describe, expect, it } from 'vitest';

import { CURSOR_TRANSIENT_FAILURE_PATTERN } from '../cursor-acp.const';
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

describe('CURSOR_TRANSIENT_FAILURE_PATTERN', () => {
  it('names the dropped-connection failures cursor-agent resumes in its own client', () => {
    for (const reported of [
      '\n\nError: RetriableError: [canceled] http/2 stream closed with error code CANCEL (0x8)',
      '\n\nError: RetriableError: [unavailable] PING timed out',
      '\n\nError: RetriableError: Stream ended without turnEnded — connection likely dropped mid-stream',
    ]) {
      const message = readCursorAgentFailure(reported);
      expect(message).not.toBeNull();
      expect(CURSOR_TRANSIENT_FAILURE_PATTERN.test(message!)).toBe(true);
    }
  });

  it('names the stall its ACP server throws without retrying even once', () => {
    // The message that killed three QA reviews in run `ce63c362` — 23, 17 and
    // 2 minutes of work — while the bracketed arm above was the whole pattern.
    // Both spellings are real constructions in the shipped bundle's `classify`
    // closure, and which one arrives says how hard the CLI already tried: the
    // BARE one is the `enableAgentRetries: false` arm its ACP server takes, so
    // it means zero attempts, where the interactive client would have made ten.
    for (const reported of [
      '\n\nError: RetriableError: Connection stalled',
      '\n\nError: RetriableError: Connection stalled repeatedly',
      '\n\nError: RetriableError: Connection failed repeatedly',
    ]) {
      const message = readCursorAgentFailure(reported);
      expect(message).not.toBeNull();
      expect(CURSOR_TRANSIENT_FAILURE_PATTERN.test(message!)).toBe(true);
    }
  });

  it('names the 429 its own policy retries three times', () => {
    // `[resource_exhausted]` is HTTP 429 in the CLI's own status map, and the
    // second of the three dead reviews. It reads like a spent account window
    // and is not one — a vendor does not retry a spent quota three times — so
    // it is resumed here rather than routed to `rate_limited`, whose contract
    // is "wait, never retry" and whose reset time this message never carries.
    const message = readCursorAgentFailure(
      '\n\nError: RetriableError: [resource_exhausted] Error',
    );
    expect(message).not.toBeNull();
    expect(CURSOR_TRANSIENT_FAILURE_PATTERN.test(message!)).toBe(true);
  });

  it('names the keepalive ping timeout, the one admitted [internal]', () => {
    // OBSERVED end to end: a real cursor turn stalled through a CONNECT proxy
    // died on this, not on `Connection stalled` — the http/2 agent's keepalive
    // gives up before the 30s stall threshold, so it wins the race whenever the
    // wire goes quiet. One construction site in the bundle, shared by the proxy
    // and direct agents, so a direct connection reports it at its own 20000ms.
    for (const reported of [
      '\n\nError: RetriableError: [internal] HTTP/2 keepalive ping timed out after 5000ms',
      '\n\nError: RetriableError: [internal] HTTP/2 keepalive ping timed out after 20000ms',
    ]) {
      const message = readCursorAgentFailure(reported);
      expect(message).not.toBeNull();
      expect(CURSOR_TRANSIENT_FAILURE_PATTERN.test(message!)).toBe(true);
    }
  });

  it('still refuses the OTHER [internal], which no retry can fix', () => {
    // The whole reason the keepalive arm is matched on its message and not on
    // its code: `[internal]` carries both, and admitting the code would resume
    // a turn three times against a token limit that is not going to move.
    const message = readCursorAgentFailure(
      '\n\nError: RetriableError: [internal] Input token limit exceeded',
    );
    expect(CURSOR_TRANSIENT_FAILURE_PATTERN.test(message!)).toBe(false);
  });

  it('leaves server answers and non-retriable failures alone', () => {
    for (const reported of [
      '\n\nError: RetriableError: [internal] Input token limit exceeded',
      '\n\nError: NonRetriableError: [canceled] something',
      '\n\nError: NonRetriableError: Connection stalled',
      '\n\nError: [unauthenticated] Backend rejected authentication.',
    ]) {
      const message = readCursorAgentFailure(reported);
      expect(message).not.toBeNull();
      expect(CURSOR_TRANSIENT_FAILURE_PATTERN.test(message!)).toBe(false);
    }
  });

  it('does not widen to a failure that merely starts like one of them', () => {
    // The `\b` after the connection families, and the closed bracket after the
    // codes. Without them `Connection stalledness` and `[resource_exhausted_x]`
    // would be resumed — a turn retried three times against a failure nothing
    // measured.
    for (const said of [
      'Error: RetriableError: Connection stalledness is not a word',
      'Error: RetriableError: [resource_exhausted_quota] gone until Tuesday',
      'Error: RetriableError: Connectionstalled',
    ]) {
      expect(CURSOR_TRANSIENT_FAILURE_PATTERN.test(said)).toBe(false);
    }
  });
});
