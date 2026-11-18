import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

import {
  defineConfig,
  MikroORM,
  UnderscoreNamingStrategy,
} from '@mikro-orm/sqlite';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { GENIRO_ORM_RUNTIME } from '../../../db/sqlite.driver';
import { ProjectDao } from '../../projects/dao/project.dao';
import { Project } from '../../projects/entity/project.entity';
import { ProjectRootsService } from '../../projects/services/project-roots.service';
import { CallContext } from '../../runs/entity/call-context.entity';
import { Item } from '../../runs/entity/item.entity';
import { NodeState } from '../../runs/entity/node-state.entity';
import { Run } from '../../runs/entity/run.entity';
import { TaskDao } from '../../tasks/dao/task.dao';
import { Task } from '../../tasks/entity/task.entity';
import { tempDir } from '../__tests__/temp-dir';
import { ItemDao } from '../dao/item.dao';
import { RunDao } from '../dao/run.dao';
import { AgentEventBus } from './agent-events.bus';
import { AgentSessionRegistry } from './agent-session.registry';
import { ItemCallIndexService } from './item-call-index.service';
import { ItemSeqAllocator } from './item-seq.allocator';
import { TurnFolderService } from './turn-folder.service';

function folder(...segments: string[]): string {
  const path = join(...segments);
  mkdirSync(path, { recursive: true });
  return realpathSync(path);
}

describe('TurnFolderService (in-memory sqlite)', () => {
  let orm: MikroORM;
  let runDao: RunDao;
  let itemDao: ItemDao;
  let projectDao: ProjectDao;
  let taskDao: TaskDao;
  let sessions: AgentSessionRegistry;
  let service: TurnFolderService;

  beforeAll(async () => {
    orm = await MikroORM.init(
      defineConfig({
        ...GENIRO_ORM_RUNTIME,
        dbName: ':memory:',
        entities: [Project, Task, Run, Item, NodeState, CallContext],
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
    runDao = new RunDao(orm.em.fork());
    itemDao = new ItemDao(orm.em.fork());
    projectDao = new ProjectDao(orm.em.fork());
    taskDao = new TaskDao(orm.em.fork());
    sessions = new AgentSessionRegistry(4);
    service = new TurnFolderService(
      orm.em,
      runDao,
      projectDao,
      new ProjectRootsService(orm.em),
      itemDao,
      new AgentEventBus(),
      new ItemCallIndexService(itemDao, runDao, orm.em),
      new ItemSeqAllocator(orm.em, itemDao),
      sessions,
    );
  });

  async function folderNotices(runId: string): Promise<string[]> {
    const items = await itemDao.getAll(
      { runId, kind: 'system' },
      undefined,
      orm.em.fork(),
    );
    return items.map((item) => {
      const payload = JSON.parse(item.payload) as {
        message: string;
        caption?: string;
        severity?: string;
      };
      expect(payload).toMatchObject({
        caption: 'folder moved',
        severity: 'info',
      });
      return payload.message;
    });
  }

  /** A card's run whose worktree, under `<root>/userData/worktrees`, is deleted. */
  async function cardRunWithDeletedWorktree(): Promise<{
    runId: string;
    gone: string;
    repo: string;
  }> {
    const root = folder(tempDir('turn-folder-service-'));
    const repo = folder(root, 'repo');
    const project = await projectDao.create({
      name: 'Repo',
      folder: folder(root, 'project'),
    });
    const task = await taskDao.create({
      projectId: project.id,
      title: 'Card',
      status: 'done',
      folder: repo,
    });
    const gone = join(root, 'userData', 'worktrees', task.id);
    const run = await runDao.create({
      status: 'completed',
      cwd: gone,
      projectId: project.id,
      taskId: task.id,
    });
    return { runId: run.id, gone, repo };
  }

  it('leaves an existing folder as it is and writes nothing', async () => {
    const cwd = folder(tempDir('turn-folder-service-'));
    const run = await runDao.create({ status: 'completed', cwd });

    await expect(service.folderFor(run.id, cwd)).resolves.toBe(cwd);
    expect(await folderNotices(run.id)).toEqual([]);
  });

  it("moves a run whose task worktree was deleted to its card's folder, once, with an info row and a prompt line", async () => {
    const { runId, gone, repo } = await cardRunWithDeletedWorktree();
    const owed = vi.spyOn(sessions, 'oweKeyNote');
    const moved = vi.fn();
    service.onMoved(moved);

    const answers = await Promise.all([
      service.folderFor(runId, gone),
      service.folderFor(runId, gone),
    ]);

    expect(answers).toEqual([repo, repo]);
    expect((await runDao.getById(runId, orm.em.fork()))?.cwd).toBe(repo);
    expect(await folderNotices(runId)).toEqual([
      `The folder ${gone} no longer exists, so this thread now works in ${repo}.`,
    ]);
    expect(owed).not.toHaveBeenCalled();

    service.oweMoveNote(runId, `${runId}::lead`);
    service.oweMoveNote(runId, `${runId}::lead`);
    service.oweMoveNote(runId, `${runId}::call:call-1`);
    const prompt = `Your working folder ${JSON.stringify(gone)} was deleted. From this turn on you work in ${JSON.stringify(repo)}; paths under the old folder no longer exist.`;
    expect(owed.mock.calls).toEqual([
      [`${runId}::lead`, prompt],
      [`${runId}::call:call-1`, prompt],
    ]);
    expect(moved).toHaveBeenCalledTimes(1);
    expect(moved).toHaveBeenCalledWith(runId);
  });

  it('answers a turn still holding the deleted folder with the folder the run already moved to', async () => {
    const { runId, gone, repo } = await cardRunWithDeletedWorktree();
    await service.folderFor(runId, gone);

    await expect(service.folderFor(runId, gone)).resolves.toBe(repo);
    expect(await folderNotices(runId)).toHaveLength(1);
  });

  it('answers a turn that lost the move to another writer with the folder that writer chose, writing nothing', async () => {
    const { runId, gone } = await cardRunWithDeletedWorktree();
    const elsewhere = folder(tempDir('turn-folder-service-'));
    const rehome = runDao.rehome.bind(runDao);
    vi.spyOn(runDao, 'rehome').mockImplementationOnce(
      async (id, from, to, forgetStart, em) => {
        await rehome(id, from, elsewhere, forgetStart, orm.em.fork());
        return rehome(id, from, to, forgetStart, em);
      },
    );

    await expect(service.folderFor(runId, gone)).resolves.toBe(elsewhere);
    expect(await folderNotices(runId)).toEqual([]);
  });

  it('moves nothing when the folder is back by the time the move would be written', async () => {
    const { runId, gone } = await cardRunWithDeletedWorktree();
    const roots = new ProjectRootsService(orm.em);
    const rootsOf = roots.rootsOf.bind(roots);
    vi.spyOn(roots, 'rootsOf').mockImplementationOnce(async (cwds) => {
      mkdirSync(gone, { recursive: true });
      return rootsOf(cwds);
    });
    const racing = new TurnFolderService(
      orm.em,
      runDao,
      projectDao,
      roots,
      itemDao,
      new AgentEventBus(),
      new ItemCallIndexService(itemDao, runDao, orm.em),
      new ItemSeqAllocator(orm.em, itemDao),
      sessions,
    );

    const answer = await racing.folderFor(runId, gone);

    expect(answer).toBe(realpathSync(gone));
    expect((await runDao.getById(runId, orm.em.fork()))?.cwd).toBe(gone);
    expect(await folderNotices(runId)).toEqual([]);
  });

  it('refuses FOLDER_GONE, moving nothing, when the folder came from no card, repository or project', async () => {
    const root = folder(tempDir('turn-folder-service-'));
    const gone = join(root, 'scratch', 'deleted');
    const run = await runDao.create({ status: 'completed', cwd: gone });

    await expect(service.folderFor(run.id, gone)).rejects.toMatchObject({
      errorCode: 'FOLDER_GONE',
    });
    expect((await runDao.getById(run.id, orm.em.fork()))?.cwd).toBe(gone);
    expect(await folderNotices(run.id)).toEqual([]);
  });

  it('still refuses a relative folder rather than moving it', async () => {
    const root = folder(tempDir('turn-folder-service-'));
    const run = await runDao.create({ status: 'completed', cwd: root });

    await expect(service.folderFor(run.id, 'relative/path')).rejects.toThrow(
      'cwd must be an absolute path',
    );
  });
});
