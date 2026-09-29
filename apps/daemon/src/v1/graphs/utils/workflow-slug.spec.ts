import { describe, expect, it } from 'vitest';

import {
  isReservedWorkflowSlug,
  RESERVED_WORKFLOW_SLUGS,
  slugifyWorkflowName,
} from './workflow-slug';

describe('slugifyWorkflowName', () => {
  it('lowercases and dashes a name', () => {
    expect(slugifyWorkflowName('Review Team')).toBe('review-team');
  });

  it('falls back to `workflow` for a name with nothing usable in it', () => {
    expect(slugifyWorkflowName('***')).toBe('workflow');
  });
});

describe('RESERVED_WORKFLOW_SLUGS', () => {
  // `GET /v1/workflows/runs` is the run list and `POST /v1/workflows/import`
  // the importer — static routes Fastify matches before `:slug`.
  it('reserves the static segments the workflows controller owns', () => {
    expect([...RESERVED_WORKFLOW_SLUGS].sort()).toEqual(['import', 'runs']);
    expect(isReservedWorkflowSlug('runs')).toBe(true);
    expect(isReservedWorkflowSlug('import')).toBe(true);
    expect(isReservedWorkflowSlug('runs-1')).toBe(false);
  });
});
