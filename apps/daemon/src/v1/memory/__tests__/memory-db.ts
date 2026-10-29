import {
  defineConfig,
  MikroORM,
  UnderscoreNamingStrategy,
} from '@mikro-orm/sqlite';

import mikroOrmConfig from '../../../db/mikro-orm.config';
import { NodeStateDao } from '../../agents/dao/node-state.dao';
import { RunDao } from '../../agents/dao/run.dao';
import { ProjectDao } from '../../projects/dao/project.dao';
import { Project } from '../../projects/entity/project.entity';
import type { ProjectRootsService } from '../../projects/services/project-roots.service';
import { NodeState } from '../../runs/entity/node-state.entity';
import { Run } from '../../runs/entity/run.entity';
import { TaskDao } from '../../tasks/dao/task.dao';
import { Task } from '../../tasks/entity/task.entity';
import { MemoryDao } from '../dao/memory.dao';
import { Memory } from '../entity/memory.entity';
import { MemoryService } from '../services/memory.service';
import { MemoryEventBus } from '../services/memory-events.bus';
import { MemoryTextIndexService } from '../services/memory-text-index.service';

/** The repository a task worktree resolves to, as `ProjectRootsService` would. */
export const ROOTS = new Map([['/wt/task-1', '/repo/app']]);

export async function memoryDb() {
  const orm = await MikroORM.init(
    defineConfig({
      dbName: ':memory:',
      entities: [Memory, Run, NodeState, Task, Project],
      allowGlobalContext: true,
      namingStrategy: UnderscoreNamingStrategy,
      discovery: { checkDuplicateFieldNames: false },
      schemaGenerator: mikroOrmConfig.schemaGenerator,
    }),
  );
  await orm.schema.update({ safe: true });
  const em = orm.em;
  const index = () => new MemoryTextIndexService(new MemoryDao(em.fork()));
  await index().ensure();
  const events = new MemoryEventBus();
  const roots = {
    rootsOf: async (cwds: Iterable<string | null>) =>
      new Map(
        [...cwds]
          .filter((cwd): cwd is string => cwd !== null)
          .map((cwd) => [cwd, ROOTS.get(cwd) ?? cwd]),
      ),
  } as unknown as ProjectRootsService;
  const service = new MemoryService(
    em,
    new MemoryDao(em),
    new RunDao(em),
    new NodeStateDao(em),
    new TaskDao(em),
    new ProjectDao(em),
    roots,
    events,
  );
  return { orm, em, service, events, index };
}

/** An entity with its defaults, as a row the app itself would write. */
export function make<T extends object>(
  entity: new () => T,
  data: Partial<T>,
): T {
  return Object.assign(new entity(), data);
}
