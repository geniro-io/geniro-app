import {
  defineConfig,
  MikroORM,
  UnderscoreNamingStrategy,
} from '@mikro-orm/sqlite';

import mikroOrmConfig from '../../../db/mikro-orm.config';
import { GENIRO_ORM_RUNTIME } from '../../../db/sqlite.driver';
import { Item } from '../../runs/entity/item.entity';
import { ReviewComment } from '../../runs/entity/review-comment.entity';
import { Run } from '../../runs/entity/run.entity';
import { ItemDao } from '../dao/item.dao';
import { ReviewCommentDao } from '../dao/review-comment.dao';
import { RunDao } from '../dao/run.dao';
import { AgentEventBus } from '../services/agent-events.bus';
import { ReviewCommentsService } from '../services/review-comments.service';

/** A ReviewCommentsService over an in-memory database, with the bus it announces on. */
export async function reviewCommentsDb() {
  const orm = await MikroORM.init(
    defineConfig({
      ...GENIRO_ORM_RUNTIME,
      dbName: ':memory:',
      entities: [ReviewComment, Run, Item],
      allowGlobalContext: true,
      namingStrategy: UnderscoreNamingStrategy,
      discovery: { checkDuplicateFieldNames: false },
      schemaGenerator: mikroOrmConfig.schemaGenerator,
    }),
  );
  await orm.schema.update({ safe: true });
  const em = orm.em;
  const bus = new AgentEventBus();
  const service = new ReviewCommentsService(
    em,
    new RunDao(em),
    new ReviewCommentDao(em),
    bus,
    new ItemDao(em),
  );
  const seedRun = async (
    id: string,
    extra: Partial<Run> = {},
  ): Promise<void> => {
    const fork = em.fork();
    fork.persist(
      Object.assign(new Run(), { id, status: 'running', ...extra } as Run),
    );
    await fork.flush();
  };
  const seedUserMessage = async (
    runId: string,
    seq: number,
    payload: Record<string, unknown>,
  ): Promise<void> => {
    const fork = em.fork();
    fork.persist(
      Object.assign(new Item(), {
        runId,
        seq,
        kind: 'message',
        role: 'user',
        payload: JSON.stringify(payload),
      }),
    );
    await fork.flush();
  };
  return { orm, em, bus, service, seedRun, seedUserMessage };
}
