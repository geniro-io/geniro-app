import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  asEmbeddingIndex,
  FakeEmbeddingIndex,
} from '../../embeddings/__tests__/fake-embedding-index';
import { ProjectDao } from '../../projects/dao/project.dao';
import type { RunPlace } from '../../projects/projects.types';
import { knowledgeDb } from '../__tests__/knowledge-db';
import { KnowledgeDocumentDao } from '../dao/knowledge-document.dao';
import { KnowledgeRevisionDao } from '../dao/knowledge-revision.dao';
import type { KnowledgeSaveOutcome } from '../knowledge.types';
import { KnowledgeService } from './knowledge.service';

type Db = Awaited<ReturnType<typeof knowledgeDb>>;

const NOWHERE: RunPlace = { projectId: null, teamSlug: null };

const RELEASE = {
  place: 'global',
  title: 'Release checklist',
  whenToRead: 'Cutting a release.',
  body: 'Tag only after CI is green.',
};
const DEPLOY = {
  place: 'global',
  title: 'Deploy steps',
  whenToRead: 'Shipping a build to the stand.',
  body: 'Restart the daemon after rebuilding.',
};

function appliedDocument(outcome: KnowledgeSaveOutcome) {
  if (outcome.kind !== 'applied') {
    throw new Error(`expected applied, got ${JSON.stringify(outcome)}`);
  }
  return outcome.document;
}

describe('KnowledgeService search by meaning', () => {
  let db: Db;
  let fake: FakeEmbeddingIndex;
  let service: KnowledgeService;

  beforeEach(async () => {
    db = await knowledgeDb();
    fake = new FakeEmbeddingIndex();
    service = new KnowledgeService(
      db.em,
      new KnowledgeDocumentDao(db.em),
      new KnowledgeRevisionDao(db.em),
      new ProjectDao(db.em),
      db.scope,
      db.memory,
      db.events,
      asEmbeddingIndex(fake),
    );
    service.setConfig({ enabled: true, agentWrites: 'review' });
  });

  afterEach(async () => {
    await db.orm.close();
  });

  it('fuses the word matches with the meaning matches, and keeps a meaning-only document', async () => {
    const release = appliedDocument(await service.create(RELEASE));
    const deploy = appliedDocument(await service.create(DEPLOY));

    fake.answerScores = () => [
      { sourceId: deploy.id, similarity: 0.8 },
      { sourceId: release.id, similarity: 0.7 },
    ];
    const meaningOnly = await service.search(NOWHERE, 'релиз', 10);
    expect(meaningOnly.hits.map((hit) => hit.handle)).toEqual([
      deploy.handle,
      release.handle,
    ]);

    const mixed = await service.search(NOWHERE, 'release', 10);
    expect(mixed.hits.map((hit) => hit.handle)).toEqual([
      release.handle,
      deploy.handle,
    ]);
    expect(fake.scoreCalls[1]).toMatchObject({
      source: 'knowledge',
      query: 'release',
    });
  });

  it('keeps the word order when the child answers nothing', async () => {
    const release = appliedDocument(await service.create(RELEASE));
    await service.create(DEPLOY);
    fake.answerScores = () => null;

    const result = await service.search(NOWHERE, 'release', 10);

    expect(result.hits.map((hit) => hit.handle)).toEqual([release.handle]);
    expect(fake.scoreCalls).toHaveLength(1);
  });

  it('answers a read of a mistaken handle with the word matches only', async () => {
    const release = appliedDocument(await service.create(RELEASE));
    const deploy = appliedDocument(await service.create(DEPLOY));
    fake.answerScores = () => [{ sourceId: deploy.id, similarity: 0.9 }];

    const read = await service.read(NOWHERE, 'release-checklst');

    expect(read).toEqual({ kind: 'missing', similar: [release.handle] });
    expect(fake.scoreCalls).toEqual([]);
  });

  it('enqueues every document it creates, for search by meaning to index', async () => {
    const created = appliedDocument(await service.create(RELEASE));

    expect(fake.enqueued).toContainEqual({
      source: 'knowledge',
      sourceIds: [created.id],
    });
  });
});
