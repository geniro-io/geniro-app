import {
  ARTIFACT_ID_PATTERN,
  type HostArtifact,
  type HostArtifactOutcome,
  MAX_ARTIFACT_ID_LENGTH,
  MAX_ARTIFACT_SUMMARY_LENGTH,
  MAX_ARTIFACT_TITLE_LENGTH,
} from '../../../agents/chat.types';
import type { AgentShareOutcome } from '../../../shares/shares.types';

/** Trim to a cap without inventing content; an absent value stays absent. */
function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed.slice(0, max);
}

/**
 * The caller's `artifact_id` as a slug, or null when it named none or named
 * something unusable.
 *
 * NORMALIZED rather than rejected, because the id is how an agent revises its
 * own page and the commonest near-misses are cosmetic — `Migration Plan` and
 * `migration_plan` are both plainly meant as a name, and refusing them would
 * answer a revision with "malformed" and leave the agent publishing a second
 * card. What survives normalization is exactly {@link ARTIFACT_ID_PATTERN},
 * which is a directory name: no separator, no `..`, nothing a filesystem reads
 * as anything but a name.
 *
 * Normalization is STABLE, which is the property revision depends on: the same
 * input always slugs to the same id, so an agent that writes its id the same
 * way twice revises rather than duplicating.
 */
function artifactId(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_ARTIFACT_ID_LENGTH)
    // A trailing `-` can reappear after the slice, and it is cheaper to cut it
    // again than to slice on a boundary.
    .replace(/-+$/g, '');
  return ARTIFACT_ID_PATTERN.test(slug) ? slug : null;
}

/**
 * Read a `show_artifact` tool call's arguments into the page the panel will
 * publish, or null when the payload carries no publishable document.
 *
 * Defensive rather than schema-validating, on the rule every host tool's reader
 * follows: the caller is a model, so a field can be anything, and the honest
 * answers are "here is what parsed" and "none of it did" — never a throw across
 * the transport.
 *
 * The html is taken WHOLE and is never trimmed to a cap here. That is the one
 * place this reader departs from its siblings, and it is deliberate: the byte
 * ceiling refuses rather than truncates ({@link MAX_ARTIFACT_HTML_BYTES}), so
 * the size decision belongs to the store that measures the encoded bytes, not
 * to a character count taken before encoding. Leading and trailing whitespace
 * still goes — a model routinely wraps a document in a blank line.
 *
 * Both a title and a document are required. A page with no heading has nothing
 * to be listed as in the rail, and a title with no document is not a page.
 */
export function readHostArtifact(
  args: Record<string, unknown>,
): HostArtifact | null {
  // `html` is the documented name; `content` is what a model reaches for when
  // it is thinking of the tool as "show this", and accepting it costs one `??`
  // against a whole page dropped over a synonym.
  const raw = args.html ?? args.content;
  if (typeof raw !== 'string') {
    return null;
  }
  const html = raw.trim();
  if (html.length === 0) {
    return null;
  }
  const title = text(args.title, MAX_ARTIFACT_TITLE_LENGTH);
  if (title === null) {
    return null;
  }
  const id = artifactId(args.artifact_id ?? args.id);
  const summary = text(args.summary, MAX_ARTIFACT_SUMMARY_LENGTH);
  return {
    title,
    html,
    ...(id === null ? {} : { id }),
    ...(summary === null ? {} : { summary }),
  };
}

/**
 * Whether the call asked for the page to be shared. Only a literal true (or
 * the string a model sometimes sends for it) counts — anything else is no.
 */
export function readShareRequested(args: Record<string, unknown>): boolean {
  return args.share === true || args.share === 'true';
}

/**
 * The tool result text for one outcome.
 *
 * A RECEIPT, never the document — the point of a published artifact is that the
 * page goes to the screen instead of back through the model's window, and
 * echoing it here would put the whole of it in the conversation twice.
 *
 * The id and version are said because they are what the agent needs to REVISE:
 * an agent that let the store mint an id has no other way to learn it, and
 * would otherwise publish a second page every time it updated its plan.
 */
export function hostArtifactResultText(
  outcome: HostArtifactOutcome,
  share: AgentShareOutcome | null = null,
): string {
  if (outcome.status === 'unavailable') {
    return `The artifact could not be shown (${outcome.reason}). Describe it in your reply instead.`;
  }
  if (outcome.status === 'rejected') {
    return `The artifact was not published (${outcome.reason}).`;
  }
  const { artifactId: id, version } = outcome;
  const receipt =
    version === 1
      ? `Artifact published and shown to the user (artifact_id: ${id}). Pass that same artifact_id to show_artifact again to revise this page in place.`
      : `Artifact ${id} updated to version ${version} and shown to the user.`;
  if (share === null) {
    return receipt;
  }
  switch (share.kind) {
    case 'shared':
      return `${receipt}\nShared link: ${share.url}`;
    case 'awaiting-sign-in':
      return `${receipt}\nNot shared yet — the user has been asked to sign in to ${share.label}. You will get a message with the link once they do; do not call show_artifact again to retry.`;
    case 'not-shared':
      return `${receipt}\nNot shared: ${share.reason}.`;
  }
}
