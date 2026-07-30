/**
 * Which claude releases this adapter's stdin control-protocol mapping has
 * actually been probed against.
 *
 * The protocol is undocumented: the `control_request` / `control_response`
 * envelope, the `can_use_tool` subtype, and the `requires_user_interaction`
 * flag that discriminates a genuine question from a permission check were all
 * established by driving a live CLI and reading what came back. That evidence
 * expires — a release can rename a field and every approval in the app starts
 * mis-mapping while the turn still looks healthy. So the versions the evidence
 * covers are written down here, and a turn that drives the protocol on
 * anything else says so.
 */

/**
 * Probed live on 2.1.202 (M4, the question discriminator) and re-probed on
 * 2.1.220 (2026-07-29, the approval envelope + `message.usage` shapes).
 *
 * Matched on `<major>.<minor>` only. The protocol has held across patch
 * releases, and pinning patches would fire on every routine CLI update —
 * a warning that cries wolf is one nobody reads.
 */
export const CONTROL_PROTOCOL_VERIFIED_SERIES = ['2.1'];

/** `"2.1.220 (Claude Code)"` → `"2.1"`; null when the line carries no version. */
export function claudeVersionSeries(version: string | null): string | null {
  const match = /(\d+)\.(\d+)\.\d+/.exec(version ?? '');
  return match ? `${match[1]}.${match[2]}` : null;
}

/**
 * Whether the control protocol has been verified against this `--version` line.
 *
 * An UNREADABLE version answers false — the point is "we have no evidence for
 * this binary", and a missing version line is exactly that. It is a reason to
 * report, never a reason to refuse the turn: the caller warns and proceeds.
 */
export function isControlProtocolVerified(version: string | null): boolean {
  const series = claudeVersionSeries(version);
  return series !== null && CONTROL_PROTOCOL_VERIFIED_SERIES.includes(series);
}

/** The one wording for the unverified-version report, so both callers match. */
export function unverifiedControlProtocolMessage(
  version: string | null,
): string {
  return (
    `claude ${version ?? '<unknown version>'} is driving the stdin control protocol, ` +
    `but this adapter's mapping has only been probed against ${CONTROL_PROTOCOL_VERIFIED_SERIES.join(', ')}. ` +
    `Tool approvals and user questions may mis-map silently — re-probe before trusting them.`
  );
}
