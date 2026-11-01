/**
 * The path segments directly under `/v1/teams/` that a ROUTE owns rather
 * than a team — `TeamsController`'s static first segments.
 *
 * A library slug is a path segment on the same prefix (`GET /v1/teams/:slug`),
 * and Fastify matches a static segment before a parametric one, so a team
 * whose slug equals one of these can be written and listed but never OPENED:
 * `GET /v1/teams/runs` answers the run list, which the builder then reads
 * as a team and throws on. `import` is reserved too although today it
 * collides only on POST: a route added under it later would reach the slug
 * with no warning.
 *
 * Add a segment here whenever `TeamsController` gains a static route whose
 * first segment could also be a slug.
 */
export const RESERVED_TEAM_SLUGS: ReadonlySet<string> = new Set([
  'runs',
  'import',
  'instruction-sizes',
]);

/** Whether `slug` is a segment a route owns — see {@link RESERVED_TEAM_SLUGS}. */
export function isReservedTeamSlug(slug: string): boolean {
  return RESERVED_TEAM_SLUGS.has(slug);
}

/**
 * The slug a team name derives: lowercase, runs of anything outside
 * `[a-z0-9]` collapsed to one dash, trimmed, capped at 64. A name with nothing
 * usable in it is `team`.
 *
 * It answers the BASE only — collisions with files already in the library, and
 * the reserved segments above, are the store's to step around, since both are
 * answered by the same suffixing loop (`runs` → `runs-1`).
 */
export function slugifyTeamName(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) || 'team'
  );
}
