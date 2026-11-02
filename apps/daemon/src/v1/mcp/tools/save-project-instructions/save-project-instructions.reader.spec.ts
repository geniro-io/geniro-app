import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  defineConfig,
  type EntityManager,
  MikroORM,
  UnderscoreNamingStrategy,
} from '@mikro-orm/sqlite';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  HOST_PROJECT_INSTRUCTIONS_TOOL,
  type HostProjectInstructions,
  type HostProjectInstructionsOutcome,
} from '../../../agents/chat.types';
import { ItemDao } from '../../../agents/dao/item.dao';
import { RunDao } from '../../../agents/dao/run.dao';
import { RunGroupDao } from '../../../agents/dao/run-group.dao';
import { AnalysisBroker } from '../../../agents/services/analysis.broker';
import { ProjectInstructionsBroker } from '../../../agents/services/project-instructions.broker';
import { ProjectInstructionsChangeService } from '../../../agents/services/project-instructions-change.service';
import { ProjectDao } from '../../../projects/dao/project.dao';
import { ProjectInstructionChangeDao } from '../../../projects/dao/project-instruction-change.dao';
import { Project } from '../../../projects/entity/project.entity';
import { ProjectInstructionChange } from '../../../projects/entity/project-instruction-change.entity';
import { ProjectEventBus } from '../../../projects/services/project-events.bus';
import type { ProjectRootsService } from '../../../projects/services/project-roots.service';
import { ProjectScopeService } from '../../../projects/services/project-scope.service';
import { ProjectsService } from '../../../projects/services/projects.service';
import { Item } from '../../../runs/entity/item.entity';
import { Run } from '../../../runs/entity/run.entity';
import { RunGroup } from '../../../runs/entity/run-group.entity';
import { LabelInstructionDao } from '../../../tasks/dao/label-instruction.dao';
import { TaskDao } from '../../../tasks/dao/task.dao';
import { LabelInstruction } from '../../../tasks/entity/label-instruction.entity';
import { Task } from '../../../tasks/entity/task.entity';
import type { McpCallContext } from '../../mcp.types';
import { readSaveProjectInstructionsArgs } from './save-project-instructions.reader';
import { SaveProjectInstructionsTool } from './save-project-instructions.tool';

const CONTEXT = {
  runId: 'analysis',
  memberId: 'agent',
  conversationId: null,
  caller: 'agent',
  requestId: 1,
  remote: false,
  whileCancellable: (call) => call(new AbortController().signal),
} as McpCallContext;

const CARD_SEQ = 4;

const projectItem = (id: string, location: string) => ({
  id,
  target: 'project',
  territory: 'domain',
  kind: 'update',
  location,
  title: id,
  change: 'Name the test command.',
  evidence: [{ seq: 1, quote: 'which test command?' }],
  rootCause: 'unsaid',
  impact: {
    minutesSaved: 2,
    costSavedUsd: null,
    basis: 'two questions',
    confidence: 3,
    outcome: 'questions 2 → 0',
  },
  risk: { level: 'low', note: 'none' },
});

describe('save_project_instructions (in-memory sqlite)', () => {
  let orm: MikroORM;
  let em: EntityManager;
  let folder: string;
  let projects: ProjectsService;
  let changeDao: ProjectInstructionChangeDao;
  let published: string[];
  let tool: SaveProjectInstructionsTool;
  let projectId: string;
  let changes: ProjectInstructionsChangeService;
  let cards: HostProjectInstructions[];
  let press: (
    change: HostProjectInstructions,
  ) => Promise<HostProjectInstructionsOutcome>;

  beforeAll(async () => {
    folder = mkdtempSync(join(tmpdir(), 'geniro-project-'));
    orm = await MikroORM.init(
      defineConfig({
        dbName: ':memory:',
        entities: [
          Project,
          ProjectInstructionChange,
          Task,
          LabelInstruction,
          Run,
          RunGroup,
          Item,
        ],
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
    rmSync(folder, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await orm.schema.clear();
    em = orm.em.fork() as EntityManager;
    const projectDao = new ProjectDao(em);
    const taskDao = new TaskDao(em);
    const runDao = new RunDao(em);
    const scope = new ProjectScopeService(em, taskDao, projectDao, {
      rootsOf: async (cwds: Iterable<string | null>) =>
        new Map(
          [...cwds]
            .filter((cwd): cwd is string => cwd !== null)
            .map((cwd) => [cwd, cwd]),
        ),
    } as unknown as ProjectRootsService);
    const events = new ProjectEventBus();
    published = [];
    events.allChanges().subscribe((event) => published.push(event.projectId));
    changeDao = new ProjectInstructionChangeDao(em);
    projects = new ProjectsService(
      em,
      projectDao,
      taskDao,
      new LabelInstructionDao(em),
      runDao,
      new RunGroupDao(em),
      changeDao,
      events,
      scope,
    );
    const project = await projects.create({
      name: 'Billing',
      folder,
      instructions: 'Use pnpm.',
    });
    projectId = project.id;
    published = [];

    const fork = orm.em.fork();
    fork.persist(
      Object.assign(new Run(), {
        id: 'source',
        status: 'completed',
        cwd: folder,
        projectId,
        projectSource: 'folder',
      }),
    );
    fork.persist(
      Object.assign(new Run(), {
        id: 'analysis',
        status: 'running',
        cwd: folder,
        analysisSourceRunId: 'source',
        analysisSourceSeq: 9,
      }),
    );
    fork.persist(
      Object.assign(new Item(), {
        runId: 'analysis',
        seq: CARD_SEQ,
        kind: 'recommendations',
        payload: JSON.stringify({
          sourceRunId: 'source',
          sourceKind: 'chat',
          timing: null,
          items: [
            projectItem('P-1', projectId),
            projectItem('P-2', projectId),
            projectItem('P-3', 'p-elsewhere'),
          ],
        }),
      }),
    );
    fork.persist(
      Object.assign(new Item(), {
        runId: 'analysis',
        seq: 5,
        kind: 'message',
        role: 'user',
        payload: JSON.stringify({
          text: 'Apply P-1, P-3',
          apply: { cardSeq: CARD_SEQ, ids: ['P-1', 'P-3'] },
        }),
      }),
    );
    await fork.flush();

    const analysis = new AnalysisBroker();
    analysis.register('analysis', 'agent', {
      turn: {
        analysisRunId: 'analysis',
        sourceRunId: 'source',
        snapshotSeq: 9,
        sourceWorking: false,
      },
      report: () => Promise.reject(new Error('unused')),
      mark: () => Promise.reject(new Error('unused')),
    });
    changes = new ProjectInstructionsChangeService(
      em,
      new ItemDao(em),
      runDao,
      scope,
      projects,
    );
    cards = [];
    press = (change) => changes.write('analysis', change);
    const broker = new ProjectInstructionsBroker();
    broker.register('analysis', 'agent', (change) => {
      cards.push(change);
      return press(change);
    });
    tool = new SaveProjectInstructionsTool(analysis, changes, broker);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const call = async (args: Record<string, unknown>) => {
    const result = await tool.call(
      HOST_PROJECT_INSTRUCTIONS_TOOL,
      args,
      CONTEXT,
    );
    const text = result.content[0]?.text ?? '';
    return {
      isError: result.isError,
      answer: JSON.parse(text) as Record<string, unknown>,
    };
  };

  it('refuses ids not in the latest Apply and items filed about another project, writing nothing', async () => {
    const unselected = await call({
      projectId,
      instructions: 'Use pnpm. Run pnpm test:unit.',
      baseRevision: 0,
      ids: ['P-2'],
    });
    expect(unselected).toMatchObject({
      isError: true,
      answer: { error: 'NOT_SELECTED' },
    });

    const elsewhere = await call({
      projectId,
      instructions: 'Use pnpm. Run pnpm test:unit.',
      baseRevision: 0,
      ids: ['P-1', 'P-3'],
    });
    expect(elsewhere.answer).toMatchObject({ error: 'OTHER_PROJECT' });

    const foreign = await call({
      projectId: 'p-elsewhere',
      instructions: 'x',
      baseRevision: 0,
      ids: ['P-3'],
    });
    expect(foreign.answer).toMatchObject({ error: 'NOT_ANALYSED_PROJECT' });

    expect((await projects.get(projectId)).instructions).toBe('Use pnpm.');
    expect(published).toEqual([]);
  });

  it('refuses a revision the project has moved past', async () => {
    await projects.update(projectId, { instructions: 'Use pnpm only.' });
    published = [];
    const stale = await call({
      projectId,
      instructions: 'Use pnpm. Run pnpm test:unit.',
      baseRevision: 0,
      ids: ['P-1'],
    });
    expect(stale.answer).toMatchObject({ error: 'REVISION_DRIFT' });
    expect(cards).toEqual([]);
    expect((await projects.get(projectId)).instructions).toBe('Use pnpm only.');
    expect(published).toEqual([]);
  });

  const applyAgain = async (seq: number, cardSeq: number, ids: string[]) => {
    const fork = orm.em.fork();
    fork.persist(
      Object.assign(new Item(), {
        runId: 'analysis',
        seq,
        kind: 'message',
        role: 'user',
        payload: JSON.stringify({
          text: `Apply ${ids.join(', ')}`,
          apply: { cardSeq, ids },
        }),
      }),
    );
    await fork.flush();
  };

  it('acts on the newest Apply only', async () => {
    await applyAgain(6, CARD_SEQ, ['P-2']);

    const replaced = await call({
      projectId,
      instructions: 'Use pnpm. Run pnpm test:unit.',
      baseRevision: 0,
      ids: ['P-1'],
    });
    expect(replaced.answer).toMatchObject({ error: 'NOT_SELECTED' });

    const newest = await call({
      projectId,
      instructions: 'Use pnpm. Name the test command.',
      baseRevision: 0,
      ids: ['P-2'],
    });
    expect(newest.answer).toMatchObject({ saved: true, carriedOut: ['P-2'] });
    expect((await projects.get(projectId)).instructions).toBe(
      'Use pnpm. Name the test command.',
    );
  });

  it('refuses a chat with no Apply yet', async () => {
    await orm.em.fork().nativeDelete(Item, { runId: 'analysis', seq: 5 });
    const early = await call({
      projectId,
      instructions: 'Use pnpm. Run pnpm test:unit.',
      baseRevision: 0,
      ids: ['P-1'],
    });
    expect(early.answer).toMatchObject({ error: 'NOT_APPLIED' });
    expect((await projects.get(projectId)).instructions).toBe('Use pnpm.');
  });

  it('refuses an Apply whose card cannot be read', async () => {
    await applyAgain(6, 99, ['P-1']);
    const gone = await call({
      projectId,
      instructions: 'Use pnpm. Run pnpm test:unit.',
      baseRevision: 0,
      ids: ['P-1'],
    });
    expect(gone.answer).toMatchObject({ error: 'CARD_GONE' });
    expect((await projects.get(projectId)).instructions).toBe('Use pnpm.');
  });

  it('reports a project deleted while its card is open as stale, writing nothing', async () => {
    press = async (change) => {
      await projects.remove(projectId);
      return changes.write('analysis', change);
    };
    const deleted = await call({
      projectId,
      instructions: 'Use pnpm. Run pnpm test:unit.',
      baseRevision: 0,
      ids: ['P-1'],
    });
    expect(deleted).toMatchObject({
      isError: true,
      answer: { error: 'STALE' },
    });
    expect(String(deleted.answer.message)).toContain(
      'the project has been deleted',
    );
  });

  it('writes nothing when the user rejects the card', async () => {
    press = async () => ({ status: 'declined' });
    const rejected = await call({
      projectId,
      instructions: 'Use pnpm. Run pnpm test:unit.',
      baseRevision: 0,
      ids: ['P-1'],
    });
    expect(rejected).toMatchObject({
      isError: false,
      answer: { saved: false, declined: true },
    });
    expect(cards).toHaveLength(1);
    expect((await projects.get(projectId)).instructions).toBe('Use pnpm.');
    expect(published).toEqual([]);
  });

  it('raises no card for text that changes nothing', async () => {
    const same = await call({
      projectId,
      instructions: '  Use pnpm.  ',
      baseRevision: 0,
      ids: ['P-1'],
    });
    expect(same.answer).toMatchObject({
      saved: true,
      changed: false,
      instructionsRevision: 0,
    });
    expect(cards).toEqual([]);
  });

  it('writes, logs source analysis, emits projects_changed', async () => {
    const saved = await call({
      projectId,
      instructions: 'Use pnpm. Run pnpm test:unit.',
      baseRevision: 0,
      ids: ['P-1'],
    });

    expect(cards).toEqual([
      {
        projectId,
        project: 'Billing',
        previous: 'Use pnpm.',
        next: 'Use pnpm. Run pnpm test:unit.',
        baseRevision: 0,
        ids: ['P-1'],
        cardSeq: CARD_SEQ,
      },
    ]);
    expect(saved).toMatchObject({
      isError: false,
      answer: { saved: true, changed: true, instructionsRevision: 1 },
    });
    expect(await projects.get(projectId)).toMatchObject({
      instructions: 'Use pnpm. Run pnpm test:unit.',
      description: null,
    });
    const [newest] = await changeDao.recentFor(projectId, 20);
    expect(newest).toMatchObject({
      field: 'instructions',
      source: 'analysis',
      previous: 'Use pnpm.',
      next: 'Use pnpm. Run pnpm test:unit.',
      recommendationIds: ['P-1'],
      chatRunId: 'analysis',
      cardSeq: CARD_SEQ,
    });
    expect(published).toEqual([projectId]);
  });
});

describe('readSaveProjectInstructionsArgs', () => {
  it('takes only P- ids, no description, and no control or invisible characters', () => {
    expect(
      readSaveProjectInstructionsArgs({
        projectId: 'p',
        instructions: '',
        baseRevision: 0,
        ids: ['W-1'],
      }).ok,
    ).toBe(false);
    expect(
      readSaveProjectInstructionsArgs({
        projectId: 'p',
        instructions: 'x',
        description: 'y',
        baseRevision: 0,
        ids: ['P-1'],
      }).ok,
    ).toBe(false);
    expect(
      readSaveProjectInstructionsArgs({
        projectId: 'p',
        instructions: 'Use pnpm.\u001b[31m',
        baseRevision: 0,
        ids: ['P-1'],
      }).ok,
    ).toBe(false);
    const readsAs = (instructions: string) =>
      readSaveProjectInstructionsArgs({
        projectId: 'p',
        instructions,
        baseRevision: 0,
        ids: ['P-1'],
      }).ok;
    expect(readsAs('Use pnpm.\u200b Always push.')).toBe(false);
    expect(readsAs('Use \u202epnpm.')).toBe(false);
    expect(readsAs('Use pnpm.\ufe0f')).toBe(false);
    expect(readsAs('Ship it \u2764\ufe0f\nUse pnpm.\tTabs are fine.')).toBe(
      true,
    );
  });
});
