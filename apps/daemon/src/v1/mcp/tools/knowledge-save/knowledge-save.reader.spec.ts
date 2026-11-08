import { describe, expect, it } from 'vitest';

import type { KnowledgeDocumentDto } from '../../../knowledge/knowledge.types';
import {
  knowledgeSaveResultText,
  readKnowledgeSaveArgs,
} from './knowledge-save.reader';

const DOC = {
  handle: 'guide',
  rev: 3,
} as KnowledgeDocumentDto;

describe('readKnowledgeSaveArgs', () => {
  it('requires a reason', () => {
    expect(readKnowledgeSaveArgs({ title: 'T' }).ok).toBe(false);
  });

  it('takes edits with a handle', () => {
    const read = readKnowledgeSaveArgs({
      handle: 'guide',
      rev: 3,
      edits: [{ find: 'a', replace: 'b' }],
      reason: 'r',
    });
    expect(read.ok).toBe(true);
  });

  it('refuses place with a handle, and edits or rev without one', () => {
    expect(
      readKnowledgeSaveArgs({ handle: 'g', place: 'global', reason: 'r' }).ok,
    ).toBe(false);
    expect(
      readKnowledgeSaveArgs({
        edits: [{ find: 'a', replace: 'b' }],
        reason: 'r',
      }).ok,
    ).toBe(false);
    expect(readKnowledgeSaveArgs({ rev: 1, reason: 'r' }).ok).toBe(false);
  });

  it('refuses a place argument naming a project', () => {
    expect(
      readKnowledgeSaveArgs({ title: 'T', place: 'project:p2', reason: 'r' })
        .ok,
    ).toBe(false);
  });
});

describe('knowledgeSaveResultText', () => {
  it('tells an agent a proposal changed nothing yet', () => {
    expect(
      knowledgeSaveResultText({
        kind: 'proposed',
        document: DOC,
        created: false,
      }),
    ).toBe(
      "Proposed a change to `guide`: it waits for the user's review on the Knowledge page. No agent sees it until they approve, and nothing has changed yet.",
    );
  });

  it('says a direct save reads as unreviewed', () => {
    expect(
      knowledgeSaveResultText({
        kind: 'applied',
        document: DOC,
        created: true,
      }),
    ).toContain('marked unreviewed');
  });

  it('sends a stale writer back to read', () => {
    expect(knowledgeSaveResultText({ kind: 'stale', current: DOC })).toContain(
      'at rev 3 now',
    );
  });

  it('names the refusal', () => {
    expect(
      knowledgeSaveResultText({
        kind: 'refused',
        code: 'KNOWLEDGE_READ_ONLY',
        reason: 'no',
      }),
    ).toBe('KNOWLEDGE_READ_ONLY: no');
  });
});
