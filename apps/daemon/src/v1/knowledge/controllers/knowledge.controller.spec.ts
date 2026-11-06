import { ConflictException, NotFoundException } from '@packages/common';
import { describe, expect, it, vi } from 'vitest';

import type {
  KnowledgeDocumentDto,
  KnowledgeRefusal,
} from '../knowledge.types';
import type { KnowledgeService } from '../services/knowledge.service';
import { KnowledgeController } from './knowledge.controller';

const DOC = { id: 'd1', handle: 'guide' } as KnowledgeDocumentDto;
const refusal = (code: KnowledgeRefusal['code']): KnowledgeRefusal => ({
  kind: 'refused',
  code,
  reason: 'no',
});

function controller(service: Partial<KnowledgeService>): KnowledgeController {
  return new KnowledgeController(service as KnowledgeService);
}

const PATCH = { rev: 1, title: 'T', whenToRead: 'W', body: 'B' };

describe('KnowledgeController', () => {
  it('answers a stale edit with 409 KNOWLEDGE_STALE', async () => {
    const subject = controller({
      edit: vi.fn(async () => ({ kind: 'stale' as const, current: DOC })),
    });

    await expect(subject.update('d1', PATCH)).rejects.toMatchObject({
      errorCode: 'KNOWLEDGE_STALE',
    });
    await expect(subject.update('d1', PATCH)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('answers a taken handle and a stale proposal with 409', async () => {
    for (const code of ['HANDLE_TAKEN', 'PROPOSAL_STALE'] as const) {
      const subject = controller({
        approve: vi.fn(async () => refusal(code)),
      });
      await expect(subject.approve('r1')).rejects.toBeInstanceOf(
        ConflictException,
      );
    }
  });

  it('answers what is not there with 404', async () => {
    const subject = controller({
      get: vi.fn(async () => null),
      revision: vi.fn(async () => null),
      exportMarkdown: vi.fn(async () => null),
      remove: vi.fn(async () => refusal('NOT_FOUND')),
    });

    await expect(subject.read('d1')).rejects.toBeInstanceOf(NotFoundException);
    await expect(subject.revision('r1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(subject.export({ id: 'd1' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(subject.remove('d1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('returns the document a write produced', async () => {
    const subject = controller({
      create: vi.fn(async () => ({
        kind: 'applied' as const,
        document: DOC,
        created: true,
      })),
    });

    await expect(
      subject.create({ place: 'global', ...PATCH }),
    ).resolves.toEqual(DOC);
  });
});
