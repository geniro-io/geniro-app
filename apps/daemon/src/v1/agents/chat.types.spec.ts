import { describe, expect, it } from 'vitest';

import {
  AgentMcpListingWireSchema,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_REQUEST_BODY_BYTES,
} from './chat.types';

/** A settled listing with one row — the ordinary answered state. */
const answered = {
  servers: [
    {
      name: 'sentry',
      target: 'node sentry.js',
      transport: 'stdio' as const,
      status: 'connected' as const,
      detail: null,
      scope: 'project' as const,
      disabled: false,
      toggleUnavailableReason: null,
      signInUnavailableReason: null,
    },
  ],
  unavailableReason: null,
  pending: false,
  interactiveOnlyNote: null,
};

describe('AgentMcpListingWireSchema — three fields, three legal states', () => {
  it('accepts each of the states the route actually answers with', () => {
    // reading…
    expect(
      AgentMcpListingWireSchema.safeParse({
        servers: [],
        unavailableReason: null,
        pending: true,
        interactiveOnlyNote: null,
      }).success,
    ).toBe(true);
    // …refused…
    expect(
      AgentMcpListingWireSchema.safeParse({
        servers: [],
        unavailableReason: 'cursor-agent could not be listed',
        pending: false,
        interactiveOnlyNote: null,
      }).success,
    ).toBe(true);
    // …answered, including the genuinely-empty folder.
    expect(AgentMcpListingWireSchema.safeParse(answered).success).toBe(true);
    expect(
      AgentMcpListingWireSchema.safeParse({
        servers: [],
        unavailableReason: null,
        pending: false,
        interactiveOnlyNote: null,
      }).success,
    ).toBe(true);
  });

  it('refuses a pending listing that also carries a reason', () => {
    // Meaningless: `pending` says the answer is not ready, a reason says it is
    // and it was a refusal. A consumer would have to pick one, and whichever it
    // picked would be a guess.
    expect(
      AgentMcpListingWireSchema.safeParse({
        servers: [],
        unavailableReason: 'could not read MCP servers',
        pending: true,
        interactiveOnlyNote: null,
      }).success,
    ).toBe(false);
  });

  it('ACCEPTS a pending listing carrying rows — the folder’s previous reading', () => {
    // Deliberately legal, and it was not: withholding the rows for the whole
    // of a re-dial is what got the panel reported as "loading for a minute",
    // since the one moment the list is most wanted is the moment it showed
    // nothing. `pending` is what keeps them honest — they are the LAST answer,
    // not this one.
    expect(
      AgentMcpListingWireSchema.safeParse({ ...answered, pending: true })
        .success,
    ).toBe(true);
  });
});

describe('MAX_REQUEST_BODY_BYTES — the transport must accept what the DTO does', () => {
  it('fits the largest message the attachment limits permit, base64 and all', () => {
    // Built for real and MEASURED rather than re-derived from the same formula:
    // the defect this pins was two files disagreeing about one promise, and a
    // spec that recomputed the arithmetic would have agreed with whichever one
    // it copied. `sendMessageSchema` accepts eight images of
    // MAX_ATTACHMENT_BYTES DECODED bytes, so the body on the wire carries their
    // base64 (4 bytes per 3) plus the JSON around it — 53MB against Fastify's
    // 1MB default, which is why eight pasted screenshots came back
    // `413 Request body is too large` before any route could run.
    const image = Buffer.alloc(MAX_ATTACHMENT_BYTES).toString('base64');
    const body = JSON.stringify({
      text: '',
      images: Array.from({ length: MAX_ATTACHMENTS_PER_MESSAGE }, () => ({
        mediaType: 'image/png',
        data: image,
      })),
    });

    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(MAX_REQUEST_BODY_BYTES);
    // And the slack is real headroom, not a rounding accident: the schema puts
    // no ceiling on the message TEXT, so a body at the attachment limit must
    // still leave room for something written beside the images.
    expect(MAX_REQUEST_BODY_BYTES - Buffer.byteLength(body)).toBeGreaterThan(
      512 * 1024,
    );
  });
});
