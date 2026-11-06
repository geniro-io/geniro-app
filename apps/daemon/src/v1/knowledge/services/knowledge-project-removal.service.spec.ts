import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RunDao } from '../../agents/dao/run.dao';
import { RunGroupDao } from '../../agents/dao/run-group.dao';
import { make } from '../../memory/__tests__/memory-db';
import { ProjectDao } from '../../projects/dao/project.dao';
import { ProjectInstructionChangeDao } from '../../projects/dao/project-instruction-change.dao';
import { Project } from '../../projects/entity/project.entity';
import { ProjectEventBus } from '../../projects/services/project-events.bus';
import { ProjectsService } from '../../projects/services/projects.service';
import { LabelInstructionDao } from '../../tasks/dao/label-instruction.dao';
import { TaskDao } from '../../tasks/dao/task.dao';
import { knowledgeDb } from '../__tests__/knowledge-db';
import type {
  KnowledgeCreateInput,
  KnowledgeSaveOutcome,
} from '../knowledge.types';
import { KnowledgeProjectRemovalService } from './knowledge-project-removal.service';

const doc = (
  over: Partial<KnowledgeCreateInput> = {},
): KnowledgeCreateInput => ({
  place: 'global',
  title: 'Release checklist',
  whenToRead: 'Cutting a release.',
  body: 'Tag only after CI is green.',
  ...over,
});

const applied = (outcome: KnowledgeSaveOutcome) => {
  if (outcome.kind !== 'applied') {
    throw new Error(`expected applied, got ${JSON.stringify(outcome)}`);
  }
  return outcome.document;
};

describe('KnowledgeProjectRemovalService', () => {
  let db: Awaited<ReturnType<typeof knowledgeDb>>;
  let projects: ProjectsService;

  const watch = () => {
    const seen: string[] = [];
    db.events.allChanges().subscribe((event) => seen.push(event.change));
    return seen;
  };

  beforeEach(async () => {
    db = await knowledgeDb();
    const em = db.orm.em.fork();
    em.persist(make(Project, { id: 'p1', name: 'Atlas', folder: '/atlas' }));
    await em.flush();
    projects = new ProjectsService(
      db.orm.em,
      new ProjectDao(db.orm.em),
      new TaskDao(db.orm.em),
      new LabelInstructionDao(db.orm.em),
      new RunDao(db.orm.em),
      new RunGroupDao(db.orm.em),
      new ProjectInstructionChangeDao(db.orm.em),
      new ProjectEventBus(),
      db.scope,
    );
    new KnowledgeProjectRemovalService(projects, db.service).onModuleInit();
  });

  afterEach(async () => {
    await db.orm.close();
  });

  it('moves a removed project’s documents to Global on the global fate, renaming a handle Global holds', async () => {
    applied(await db.service.create(doc({ handle: 'same' })));
    applied(
      await db.service.create(doc({ handle: 'same', place: 'project:p1' })),
    );
    applied(
      await db.service.create(doc({ handle: 'other', place: 'project:p1' })),
    );
    const seen = watch();
    expect(await projects.remove('p1', 'global')).toMatchObject({
      deleted: true,
      knowledgeMoved: 2,
      knowledgeDeleted: 0,
      knowledgeRenamed: [{ from: 'same', to: 'same-2' }],
    });
    const { documents } = await db.service.list({ place: 'global' });
    expect(documents.map((row) => row.handle).sort()).toEqual([
      'other',
      'same',
      'same-2',
    ]);
    expect((await db.service.list({ place: 'project:p1' })).documents).toEqual(
      [],
    );
    expect(seen).toEqual(['bulk']);
  });

  it('deletes a removed project’s documents on the delete fate and keeps Global’s', async () => {
    applied(await db.service.create(doc({ handle: 'keep' })));
    const gone = applied(
      await db.service.create(doc({ handle: 'gone', place: 'project:p1' })),
    );
    const seen = watch();
    expect(await projects.remove('p1', 'delete')).toMatchObject({
      deleted: true,
      knowledgeMoved: 0,
      knowledgeDeleted: 1,
      knowledgeRenamed: [],
    });
    expect(await db.service.get(gone.id)).toBeNull();
    expect((await db.service.revisions(gone.id)).revisions).toEqual([]);
    const { documents } = await db.service.list({ place: 'global' });
    expect(documents.map((row) => row.handle)).toEqual(['keep']);
    expect(seen).toEqual(['deleted']);
  });

  it('publishes nothing when the removed project held no documents', async () => {
    const seen = watch();
    expect(await projects.remove('p1', 'global')).toMatchObject({
      deleted: true,
      knowledgeMoved: 0,
      knowledgeDeleted: 0,
      knowledgeRenamed: [],
    });
    expect(seen).toEqual([]);
  });
});
