import { describe, expect, it } from 'vitest';

import {
  knowledgeEmbeddingChunks,
  knowledgeTextHash,
} from './knowledge-embedding';

describe('knowledgeEmbeddingChunks', () => {
  it('cuts a document at its headings and leads every piece with the title and when-to-read line', () => {
    const chunks = knowledgeEmbeddingChunks(
      'Deploy',
      'When shipping a build',
      '## Steps\nrun it\n\n## Rollback\nundo it',
    );

    expect(chunks).toEqual([
      'Deploy\nWhen shipping a build\n\n## Steps\nrun it',
      'Deploy\nWhen shipping a build\n\n## Rollback\nundo it',
    ]);
  });

  it('keeps the text before the first heading as a piece of its own', () => {
    const chunks = knowledgeEmbeddingChunks(
      'Deploy',
      'When shipping a build',
      'intro line\n## Part\ntext',
    );

    expect(chunks).toEqual([
      'Deploy\nWhen shipping a build\n\nintro line',
      'Deploy\nWhen shipping a build\n\n## Part\ntext',
    ]);
  });

  it('answers the head alone for a document with no body', () => {
    expect(
      knowledgeEmbeddingChunks('Deploy', 'When shipping a build', ''),
    ).toEqual(['Deploy\nWhen shipping a build']);
  });

  it('answers the body alone when the title and when-to-read line are blank', () => {
    expect(knowledgeEmbeddingChunks(' ', '', '## Only\nbody')).toEqual([
      '## Only\nbody',
    ]);
  });

  it('answers nothing for a document with no text at all', () => {
    expect(knowledgeEmbeddingChunks('', '', '')).toEqual([]);
  });
});

describe('knowledgeTextHash', () => {
  it('changes when any one of the three fields changes', () => {
    const base = knowledgeTextHash('Title', 'When', 'Body');

    expect(knowledgeTextHash('Title', 'When', 'Body')).toBe(base);
    expect(knowledgeTextHash('Title2', 'When', 'Body')).not.toBe(base);
    expect(knowledgeTextHash('Title', 'When2', 'Body')).not.toBe(base);
    expect(knowledgeTextHash('Title', 'When', 'Body2')).not.toBe(base);
  });
});
