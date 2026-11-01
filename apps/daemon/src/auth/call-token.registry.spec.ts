import { afterEach, describe, expect, it } from 'vitest';

import { clearSecrets, redactSecrets } from '../v1/diagnostics/utils/redact';
import { CallTokenRegistry } from './call-token.registry';

/** A realistic call token — 64 hex chars, like the ones `mintToken` produces. */
const TOKEN = 'a'.repeat(32) + 'b'.repeat(32);

describe('CallTokenRegistry', () => {
  afterEach(() => {
    clearSecrets();
  });

  it('keys a token by (runId, memberId) so one member cannot claim another’s route', () => {
    const registry = new CallTokenRegistry();
    registry.issue('run-1', 'member-a', TOKEN);

    expect(registry.get('run-1', 'member-a')).toBe(TOKEN);
    expect(registry.get('run-1', 'member-b')).toBeNull();
    expect(registry.get('run-2', 'member-a')).toBeNull();
  });

  it('revokes a settled run’s whole set', () => {
    const registry = new CallTokenRegistry();
    registry.issue('run-1', 'member-a', TOKEN);
    registry.issue('run-1', 'member-b', `${TOKEN}-other`);

    registry.revokeRun('run-1');

    expect(registry.get('run-1', 'member-a')).toBeNull();
    expect(registry.get('run-1', 'member-b')).toBeNull();
  });

  it('registers every minted token for redaction, so it cannot reach the debug log', () => {
    // `utils/redact.ts` states a call token "may not leave the process in plain
    // text" and the diagnostics report promises "it carries no secrets" — but
    // only the launch token and the cursor key were ever registered, so both
    // claims were false for THIS credential. With the `agent-stdio` channel on,
    // the cursor `session/new` frame carries it verbatim into
    // `<userData>/logs/*.jsonl` and into the report tail users are invited to
    // paste publicly.
    //
    // Drop the `registerSecret` call from `issue()` and this fails: the raw
    // token survives the scrub.
    const registry = new CallTokenRegistry();
    registry.issue('run-1', 'member-a', TOKEN);

    const frame = `{"headers":[{"name":"Authorization","value":"Bearer ${TOKEN}"}]}`;
    const scrubbed = redactSecrets(frame);

    expect(scrubbed).not.toContain(TOKEN);
    expect(scrubbed).toContain('call token');
  });

  it('does not register anything when there is no token to protect', () => {
    // The guard in `registerSecret` ignores a short value, so an empty token
    // cannot turn every log line into a mask. Asserted because the alternative
    // failure is silent and total.
    const registry = new CallTokenRegistry();
    registry.issue('run-1', 'member-a', '');

    expect(redactSecrets('an ordinary log line')).toBe('an ordinary log line');
  });
});
