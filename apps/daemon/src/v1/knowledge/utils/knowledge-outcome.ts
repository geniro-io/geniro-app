import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@packages/common';

import type {
  KnowledgeDocumentDto,
  KnowledgeRefusal,
  KnowledgeSaveOutcome,
} from '../knowledge.types';

/** The HTTP error a refusal is. */
export function refusalError(refusal: KnowledgeRefusal): Error {
  switch (refusal.code) {
    case 'NOT_FOUND':
      return new NotFoundException('KNOWLEDGE_NOT_FOUND', refusal.reason);
    case 'HANDLE_TAKEN':
    case 'PROPOSAL_STALE':
    case 'TOO_MANY_PROPOSALS':
      return new ConflictException(refusal.code, refusal.reason);
    default:
      return new BadRequestException(refusal.code, refusal.reason);
  }
}

/** The HTTP error a write on an old `rev` is. */
export function staleError(): Error {
  return new ConflictException(
    'KNOWLEDGE_STALE',
    'the document changed since it was read — reload it and try again',
  );
}

/** The document a user's write produced, or the HTTP error its refusal is. */
export function savedDocumentOrThrow(
  outcome: KnowledgeSaveOutcome | KnowledgeRefusal,
): KnowledgeDocumentDto {
  if (outcome.kind === 'applied') {
    return outcome.document;
  }
  if (outcome.kind === 'stale') {
    throw staleError();
  }
  if (outcome.kind === 'proposed') {
    throw new ConflictException(
      'KNOWLEDGE_PROPOSED',
      'the write is waiting on review',
    );
  }
  throw refusalError(outcome);
}
