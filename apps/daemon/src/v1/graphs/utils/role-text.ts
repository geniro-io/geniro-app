/**
 * Collapse a node's role to a single line, capped at `max` characters with a
 * trailing ellipsis when longer. Shared by the MCP tool description
 * (`shortRole`) and the caller-awareness system-prompt block — a role is
 * free-form multi-line text, and both embed it inline where newlines and
 * runaway length would corrupt the surrounding structure. Empty/absent → ''.
 */
export function flattenRole(
  role: string | undefined | null,
  max: number,
): string {
  if (!role) {
    return '';
  }
  const flat = role.replaceAll(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}
