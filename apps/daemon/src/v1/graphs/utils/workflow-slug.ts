/**
 * The path segments directly under `/v1/workflows/` that a ROUTE owns rather
 * than a workflow — `WorkflowsController`'s static first segments.
 *
 * A library slug is a path segment on the same prefix (`GET /v1/workflows/:slug`),
 * and Fastify matches a static segment before a parametric one, so a workflow
 * whose slug equals one of these can be written and listed but never OPENED:
 * `GET /v1/workflows/runs` answers the run list, which the builder then reads
 * as a workflow and throws on. REPORTED as a workflow named "Runs" that could
 * not be opened. `import` is reserved too although today it collides only on
 * POST: a route added under it later would reach the slug with no warning.
 *
 * Add a segment here whenever `WorkflowsController` gains a static route whose
 * first segment could also be a slug.
 */
export const RESERVED_WORKFLOW_SLUGS: ReadonlySet<string> = new Set([
  'runs',
  'import',
]);

/** Whether `slug` is a segment a route owns — see {@link RESERVED_WORKFLOW_SLUGS}. */
export function isReservedWorkflowSlug(slug: string): boolean {
  return RESERVED_WORKFLOW_SLUGS.has(slug);
}

/**
 * The slug a workflow name derives: lowercase, runs of anything outside
 * `[a-z0-9]` collapsed to one dash, trimmed, capped at 64. A name with nothing
 * usable in it is `workflow`.
 *
 * It answers the BASE only — collisions with files already in the library, and
 * the reserved segments above, are the store's to step around, since both are
 * answered by the same suffixing loop (`runs` → `runs-1`).
 */
export function slugifyWorkflowName(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) || 'workflow'
  );
}
