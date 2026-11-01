import {
  defineConfig,
  type EntityManager,
  MikroORM,
  UnderscoreNamingStrategy,
} from '@mikro-orm/sqlite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { Run } from '../../runs/entity/run.entity';
import { RunGroup } from '../../runs/entity/run-group.entity';
import { TaskDao } from '../../tasks/dao/task.dao';
import { LabelInstruction } from '../../tasks/entity/label-instruction.entity';
import { Task } from '../../tasks/entity/task.entity';
import { ProjectDao } from '../dao/project.dao';
import { Project } from '../entity/project.entity';
import type { ProjectRootsService } from './project-roots.service';
import { ProjectScopeService } from './project-scope.service';

const WORKTREES = new Map([['/wt/task-1', '/repo/app']]);

const roots = {
  rootsOf: async (cwds: Iterable<string | null>) =>
    new Map(
      [...cwds]
        .filter((cwd): cwd is string => cwd !== null)
        .map((cwd) => [cwd, WORKTREES.get(cwd) ?? cwd]),
    ),
} as unknown as ProjectRootsService;

describe('ProjectScopeService (in-memory sqlite)', () => {
  let orm: MikroORM;
  let em: EntityManager;
  let service: ProjectScopeService;

  beforeAll(async () => {
    orm = await MikroORM.init(
      defineConfig({
        dbName: ':memory:',
        entities: [Project, Task, LabelInstruction, Run, RunGroup],
        ignoreUndefinedInQuery: true,
        allowGlobalContext: true,
        namingStrategy: UnderscoreNamingStrategy,
        discovery: { checkDuplicateFieldNames: false },
      }),
    );
    await orm.schema.create();
  });

  afterAll(async () => {
    await orm.close(true);
  });

  beforeEach(async () => {
    await orm.schema.clear();
    em = orm.em.fork() as EntityManager;
    service = new ProjectScopeService(
      em,
      new TaskDao(em),
      new ProjectDao(em),
      roots,
    );
    em.persist(
      Object.assign(new Project(), {
        id: 'p-cards',
        name: 'Cards',
        folder: '/elsewhere',
        description: 'The card board.',
        instructions: 'Keep cards small.',
      }),
    );
    em.persist(
      Object.assign(new Project(), {
        id: 'p-app',
        name: 'App',
        folder: '/repo/app',
        instructions: 'Use pnpm.',
      }),
    );
    em.persist(
      Object.assign(new Task(), {
        id: 'task-1',
        projectId: 'p-cards',
        title: 'T',
      }),
    );
    await em.flush();
  });

  describe('projectOf', () => {
    it('takes the task card’s project over the folder the run works in', async () => {
      const project = await service.projectOf({
        taskId: 'task-1',
        cwd: '/repo/app',
      });
      expect(project?.id).toBe('p-cards');
    });

    it('falls back to the folder when the card’s project is gone', async () => {
      const row = await em.findOneOrFail(Project, 'p-cards');
      em.remove(row);
      await em.flush();
      const project = await service.projectOf({
        taskId: 'task-1',
        cwd: '/repo/app',
      });
      expect(project?.id).toBe('p-app');
    });

    it('takes the project whose folder the run’s worktree resolves to', async () => {
      expect(
        (await service.projectOf({ taskId: null, cwd: '/wt/task-1' }))?.id,
      ).toBe('p-app');
    });

    it('matches none for a subfolder of a project’s folder, and for no folder', async () => {
      expect(
        await service.projectOf({ taskId: null, cwd: '/repo/app/packages/x' }),
      ).toBeNull();
      expect(await service.projectOf({ taskId: null, cwd: null })).toBeNull();
    });
  });

  describe('instructionsSnapshot', () => {
    it('composes the name, description and instructions of the run’s project', async () => {
      expect(
        await service.instructionsSnapshot({ taskId: 'task-1', cwd: null }),
      ).toBe('Project: Cards\n\nThe card board.\n\nKeep cards small.');
    });

    it('is null for a project with neither, and for a run in no project', async () => {
      const row = await em.findOneOrFail(Project, 'p-app');
      row.instructions = null;
      await em.flush();

      expect(
        await service.instructionsSnapshot({ taskId: null, cwd: '/repo/app' }),
      ).toBeNull();
      expect(
        await service.instructionsSnapshot({ taskId: null, cwd: '/nowhere' }),
      ).toBeNull();
    });

    it('is null rather than a failure when the project cannot be read', async () => {
      const broken = new ProjectScopeService(
        em,
        new TaskDao(em),
        {
          getById: async () => {
            throw new Error('db gone');
          },
          findAnyByFolder: async () => {
            throw new Error('db gone');
          },
        } as unknown as ProjectDao,
        roots,
      );
      expect(
        await broken.instructionsSnapshot({ taskId: null, cwd: '/repo/app' }),
      ).toBeNull();
    });
  });
});
