import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  PAYLOAD_PREVIEW,
  PAYLOAD_WINDOW,
  payloadPreview,
} from './payload-preview';
import { clearSecrets, redactSecrets, registerSecret } from './redact';

/** The preview of masking the WHOLE payload, which the window must reproduce. */
function reference(text: string): string {
  const flat = redactSecrets(text).replace(/\s+/g, ' ');
  return flat.length > PAYLOAD_PREVIEW
    ? `${flat.slice(0, PAYLOAD_PREVIEW)}…`
    : flat;
}

/**
 * Text that flattens to exactly `visible` characters, then blanks out to
 * `start`, where whatever follows begins.
 */
function lead(visible: number, start: number): string {
  const word = `${'a'.repeat(visible - 1)} `;
  return `${word}${' '.repeat(start - word.length)}`;
}

/**
 * Every place `secret` can sit around the window's edge — from wholly before it
 * to wholly after — under every fill of the preview from 20 characters short of
 * full up to one short, so the edge lands in each place of the secret whichever
 * window the implementation cuts at.
 */
function placements(secret: string): [string, string][] {
  const found: [string, string][] = [];
  for (
    let visible = PAYLOAD_PREVIEW - 20;
    visible < PAYLOAD_PREVIEW;
    visible += 1
  ) {
    for (
      let start = PAYLOAD_WINDOW - secret.length;
      start <= PAYLOAD_WINDOW + secret.length;
      start += 1
    ) {
      found.push([
        `${visible} characters shown, secret starting ${start - PAYLOAD_WINDOW} from the edge`,
        `${lead(visible, start)}${secret}${'z'.repeat(2000)}`,
      ]);
    }
  }
  return found;
}

const SECRET = 's3cr3t-'.repeat(6);

beforeEach(() => {
  clearSecrets();
});

afterEach(() => {
  clearSecrets();
});

describe('payloadPreview', () => {
  it('is empty for no payload', () => {
    expect(payloadPreview(null)).toBe('');
    expect(payloadPreview(undefined)).toBe('');
  });

  it('collapses whitespace and cuts a long payload with an ellipsis', () => {
    const preview = payloadPreview({ text: `a\n\n  b ${'x'.repeat(600)}` });
    expect(preview.startsWith('{"text":"a\\n\\n b')).toBe(true);
    expect(preview).toHaveLength(PAYLOAD_PREVIEW + 1);
    expect(preview.endsWith('…')).toBe(true);
  });

  it('renders something for a payload JSON cannot carry', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(payloadPreview(circular)).toBe('[object Object]');
    expect(payloadPreview(() => undefined)).toContain('=>');
  });

  it('masks a payload that fits the window whole', () => {
    const seen: number[] = [];
    const text = `prefix ${SECRET} suffix`;
    expect(
      payloadPreview(
        text,
        (input) => {
          seen.push(input.length);
          return input.split(SECRET).join('<masked>');
        },
        SECRET.length,
      ),
    ).toBe('prefix <masked> suffix');
    expect(seen).toEqual([text.length]);
  });

  it('hands the masker no more than a window of a long payload', () => {
    const seen: number[] = [];
    const preview = payloadPreview(
      'x'.repeat(200_000),
      (input) => {
        seen.push(input.length);
        return input;
      },
      SECRET.length,
    );
    expect(Math.max(...seen)).toBeLessThanOrEqual(
      PAYLOAD_WINDOW + SECRET.length,
    );
    expect(preview).toBe(`${'x'.repeat(PAYLOAD_PREVIEW)}…`);
  });

  describe('through the registry, shows what masking the whole payload would have shown', () => {
    // Every case calls `payloadPreview(text)` bare, so the masker and the
    // secret length it reads are the ones production uses.
    beforeEach(() => {
      expect(registerSecret(SECRET, 'key')).toBe(true);
    });

    const cases: [string, string][] = [
      ['plain text beyond the window', 'word '.repeat(9000)],
      [
        'a payload that collapses to almost nothing before the window ends',
        `a${' '.repeat(5000)}${'b'.repeat(2000)}`,
      ],
      [
        'a secret inside the preview',
        `${'a'.repeat(100)}${SECRET}${'b '.repeat(9000)}`,
      ],
      [
        'a secret the window cuts, past the preview',
        `${'c '.repeat(PAYLOAD_WINDOW / 2 - 10)}${SECRET}${'d '.repeat(3000)}`,
      ],
      [
        'a secret the window cuts, in a payload that collapses to almost nothing',
        `${' '.repeat(PAYLOAD_WINDOW - 5)}${SECRET}${' '.repeat(5000)}tail`,
      ],
      [
        // 10 characters short of a full preview, then the first 20 of a
        // secret: the window ends inside it, and a preview of the window
        // would show 10 of them.
        'a secret the window cuts, inside what a preview would show',
        `${lead(PAYLOAD_PREVIEW - 10, PAYLOAD_WINDOW - 20)}${SECRET}${'z'.repeat(2000)}`,
      ],
      [
        'a secret the window cuts, right after a short preview',
        `${'ab'.repeat(60)}${' '.repeat(PAYLOAD_WINDOW - 130)}${SECRET}${'z'.repeat(2000)}`,
      ],
      [
        'a payload that flattens to exactly a preview, the rest blanks',
        `${'a'.repeat(PAYLOAD_PREVIEW - 1)}${' '.repeat(PAYLOAD_WINDOW * 2)}`,
      ],
      [
        'a payload that is mostly secrets',
        `${`${SECRET}.`.repeat(60)}${'e'.repeat(PAYLOAD_WINDOW)}`,
      ],
    ];

    it.each(cases)('%s', (_name, text) => {
      const preview = payloadPreview(text);
      expect(preview).toBe(reference(text));
      // The property that matters, stated on its own: no part of the secret
      // reaches the preview, whichever way the window fell across it.
      expect(preview).not.toContain('s3cr3');
    });

    it('shows the whole-payload preview wherever the secret sits around the window’s edge', () => {
      for (const [where, text] of placements(SECRET)) {
        expect(payloadPreview(text), where).toBe(reference(text));
      }
    });
  });

  describe('when one registered secret holds another', () => {
    // The shape an approval answer takes: the whole submission is registered,
    // and so is the secret value inside it. Under a label longer than that
    // value its mask is LONGER than the text it replaces, so what the window's
    // cut leaves half-scanned is longer once masked than it was.
    const INNER = 'k-1234567890';
    const OUTER = `Token: ${INNER}\nRegion: eu-west-1 and a good deal more text after the value`;

    beforeEach(() => {
      // Registration refuses a value under the registry's minimum, which would
      // leave the sweep below testing nothing.
      expect(registerSecret(OUTER, 'approval answer')).toBe(true);
      expect(registerSecret(INNER, 'approval answer')).toBe(true);
    });

    it('shows the whole-payload preview wherever the outer secret sits around the window’s edge', () => {
      for (const [where, text] of placements(OUTER)) {
        const preview = payloadPreview(text);
        expect(preview, where).toBe(reference(text));
        expect(preview, where).not.toContain('Token:');
      }
    });
  });
});
