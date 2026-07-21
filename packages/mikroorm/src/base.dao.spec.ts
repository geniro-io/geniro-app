import { Entity, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';
import type { EntityManager, SqlEntityRepository } from '@mikro-orm/postgresql';
import { defineConfig, MikroORM } from '@mikro-orm/sqlite';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { BaseDao } from './base.dao';
import { TimestampsEntity } from './base.entity';

class TestEntity {
  id!: string;
  name!: string;
  deletedAt: Date | null = null;
}

/** Real-driver fixture for the sqlite describe below. */
@Entity({ tableName: 'things' })
class Thing extends TimestampsEntity {
  @PrimaryKey({ type: 'string' })
  id!: string;

  @Property({ type: 'string' })
  name!: string;
}

class ThingDao extends BaseDao<Thing> {
  constructor(em: import('@mikro-orm/sqlite').EntityManager) {
    super(em, Thing);
  }
}

class TestDao extends BaseDao<TestEntity> {
  constructor(em: EntityManager) {
    super(em, TestEntity);
  }
}

function createMockRepo(): SqlEntityRepository<TestEntity> {
  return {
    find: vi.fn(),
    findOne: vi.fn(),
    count: vi.fn(),
    create: vi.fn(),
  } as unknown as SqlEntityRepository<TestEntity>;
}

function createMockEm(repo: SqlEntityRepository<TestEntity>): EntityManager {
  const identityMap = { delete: vi.fn() };
  const uow = { getIdentityMap: vi.fn().mockReturnValue(identityMap) };
  return {
    flush: vi.fn(),
    remove: vi.fn(),
    getReference: vi.fn(),
    getRepository: vi.fn().mockReturnValue(repo),
    getUnitOfWork: vi.fn().mockReturnValue(uow),
  } as unknown as EntityManager;
}

describe('BaseDao', () => {
  let em: EntityManager;
  let repo: SqlEntityRepository<TestEntity>;
  let dao: TestDao;

  beforeEach(() => {
    repo = createMockRepo();
    em = createMockEm(repo);
    dao = new TestDao(em);
  });

  it('getAll delegates to repo.find with correct args', async () => {
    const where = { name: 'test' };
    const options = { limit: 10 };
    const expected = [{ id: '1', name: 'test', deletedAt: null }];
    vi.mocked(repo.find).mockResolvedValue(expected);

    const result = await dao.getAll(where as never, options as never);

    expect(repo.find).toHaveBeenCalledWith(where, options);
    expect(result).toBe(expected);
  });

  it('getOne delegates to repo.findOne', async () => {
    const where = { name: 'test' };
    const expected = { id: '1', name: 'test', deletedAt: null };
    vi.mocked(repo.findOne).mockResolvedValue(expected);

    const result = await dao.getOne(where as never);

    expect(repo.findOne).toHaveBeenCalledWith(where, undefined);
    expect(result).toBe(expected);
  });

  it('getById calls repo.findOne with { id } filter', async () => {
    const expected = { id: 'abc', name: 'test', deletedAt: null };
    vi.mocked(repo.findOne).mockResolvedValue(expected);

    const result = await dao.getById('abc');

    expect(repo.findOne).toHaveBeenCalledWith({ id: 'abc' });
    expect(result).toBe(expected);
  });

  it('count delegates to repo.count', async () => {
    const where = { name: 'test' };
    vi.mocked(repo.count).mockResolvedValue(42);

    const result = await dao.count(where as never);

    expect(repo.count).toHaveBeenCalledWith(where);
    expect(result).toBe(42);
  });

  it('create calls repo.create with partial option + em.flush', async () => {
    const data = { name: 'new' };
    const created = { id: '1', name: 'new', deletedAt: null };
    vi.mocked(repo.create).mockReturnValue(created as never);

    const result = await dao.create(data);

    expect(repo.create).toHaveBeenCalledWith(data, { partial: true });
    expect(em.flush).toHaveBeenCalledOnce();
    expect(result).toBe(created);
  });

  it('create with txEm uses transactional EM repo', async () => {
    const txRepo = createMockRepo();
    const txEm = createMockEm(txRepo);
    const data = { name: 'new' };
    const created = { id: '1', name: 'new', deletedAt: null };
    vi.mocked(txRepo.create).mockReturnValue(created as never);

    const result = await dao.create(data, txEm);

    expect(txEm.getRepository).toHaveBeenCalledWith(TestEntity);
    expect(txRepo.create).toHaveBeenCalledWith(data, { partial: true });
    expect(txEm.flush).toHaveBeenCalledOnce();
    expect(em.flush).not.toHaveBeenCalled();
    expect(result).toBe(created);
  });

  it('createMany creates multiple entities and flushes once', async () => {
    const data = [{ name: 'a' }, { name: 'b' }];
    const entityA = { id: '1', name: 'a', deletedAt: null };
    const entityB = { id: '2', name: 'b', deletedAt: null };
    vi.mocked(repo.create)
      .mockReturnValueOnce(entityA as never)
      .mockReturnValueOnce(entityB as never);

    const result = await dao.createMany(data);

    expect(repo.create).toHaveBeenCalledTimes(2);
    expect(repo.create).toHaveBeenCalledWith(data[0], { partial: true });
    expect(repo.create).toHaveBeenCalledWith(data[1], { partial: true });
    expect(em.flush).toHaveBeenCalledOnce();
    expect(result).toEqual([entityA, entityB]);
  });

  it('updateById loads entity, assigns data, flushes, returns 1', async () => {
    const entity: TestEntity = { id: 'abc', name: 'old', deletedAt: null };
    vi.mocked(repo.findOne).mockResolvedValue(entity);

    const result = await dao.updateById('abc', { name: 'updated' });

    expect(repo.findOne).toHaveBeenCalledWith({ id: 'abc' });
    expect(entity.name).toBe('updated');
    expect(em.flush).toHaveBeenCalledOnce();
    expect(result).toBe(1);
  });

  it('updateById returns 0 and skips flush when entity not found', async () => {
    vi.mocked(repo.findOne).mockResolvedValue(null);

    const result = await dao.updateById('missing', { name: 'updated' });

    expect(em.flush).not.toHaveBeenCalled();
    expect(result).toBe(0);
  });

  it('updateById with txEm uses transactional EM repo and flush', async () => {
    const txRepo = createMockRepo();
    const txEm = createMockEm(txRepo);
    const entity: TestEntity = { id: 'abc', name: 'old', deletedAt: null };
    vi.mocked(txRepo.findOne).mockResolvedValue(entity);

    const result = await dao.updateById('abc', { name: 'updated' }, txEm);

    expect(txEm.getRepository).toHaveBeenCalledWith(TestEntity);
    expect(entity.name).toBe('updated');
    expect(txEm.flush).toHaveBeenCalledOnce();
    expect(em.flush).not.toHaveBeenCalled();
    expect(result).toBe(1);
  });

  it('deleteById sets deletedAt, flushes, and evicts from identity map', async () => {
    const entity: TestEntity = { id: 'abc', name: 'x', deletedAt: null };
    vi.mocked(repo.findOne).mockResolvedValue(entity);
    const beforeCall = new Date();

    await dao.deleteById('abc');

    expect(repo.findOne).toHaveBeenCalledWith({ id: 'abc' });
    expect(entity.deletedAt).not.toBeNull();
    expect(entity.deletedAt!.getTime()).toBeGreaterThanOrEqual(
      beforeCall.getTime(),
    );
    expect(em.flush).toHaveBeenCalledOnce();
    const identityMap = vi.mocked(em.getUnitOfWork)().getIdentityMap();
    expect(identityMap.delete).toHaveBeenCalledWith(entity);
  });

  it('deleteById is a no-op when entity not found', async () => {
    vi.mocked(repo.findOne).mockResolvedValue(null);

    await dao.deleteById('missing');

    expect(em.flush).not.toHaveBeenCalled();
  });

  it('deleteById with txEm uses transactional EM repo and flush', async () => {
    const txRepo = createMockRepo();
    const txEm = createMockEm(txRepo);
    const entity: TestEntity = { id: 'abc', name: 'x', deletedAt: null };
    vi.mocked(txRepo.findOne).mockResolvedValue(entity);

    await dao.deleteById('abc', txEm);

    expect(txEm.getRepository).toHaveBeenCalledWith(TestEntity);
    expect(entity.deletedAt).not.toBeNull();
    expect(txEm.flush).toHaveBeenCalledOnce();
    expect(em.flush).not.toHaveBeenCalled();
  });

  it('delete sets deletedAt on every match, flushes once, and evicts each', async () => {
    const entities: TestEntity[] = [
      { id: '1', name: 'a', deletedAt: null },
      { id: '2', name: 'b', deletedAt: null },
    ];
    vi.mocked(repo.find).mockResolvedValue(entities);

    await dao.delete({ name: 'x' } as never);

    expect(entities[0]!.deletedAt).not.toBeNull();
    expect(entities[1]!.deletedAt).not.toBeNull();
    expect(em.flush).toHaveBeenCalledOnce();
    const identityMap = vi.mocked(em.getUnitOfWork)().getIdentityMap();
    expect(identityMap.delete).toHaveBeenCalledTimes(2);
    expect(identityMap.delete).toHaveBeenCalledWith(entities[0]);
    expect(identityMap.delete).toHaveBeenCalledWith(entities[1]);
  });

  it('delete is a no-op when no matches found', async () => {
    vi.mocked(repo.find).mockResolvedValue([]);

    await dao.delete({ name: 'x' } as never);

    expect(em.flush).not.toHaveBeenCalled();
  });

  it('hardDeleteById schedules removal via em.remove and flushes', async () => {
    const ref = { id: 'abc' } as TestEntity;
    vi.mocked(em.getReference).mockReturnValue(ref);

    await dao.hardDeleteById('abc');

    expect(em.getReference).toHaveBeenCalledWith(TestEntity, 'abc');
    expect(em.remove).toHaveBeenCalledWith(ref);
    expect(em.flush).toHaveBeenCalledOnce();
  });

  it('hardDeleteById with txEm uses transactional EM', async () => {
    const txRepo = createMockRepo();
    const txEm = createMockEm(txRepo);
    const ref = { id: 'abc' } as TestEntity;
    vi.mocked(txEm.getReference).mockReturnValue(ref);

    await dao.hardDeleteById('abc', txEm);

    expect(txEm.getReference).toHaveBeenCalledWith(TestEntity, 'abc');
    expect(txEm.remove).toHaveBeenCalledWith(ref);
    expect(txEm.flush).toHaveBeenCalledOnce();
    expect(em.remove).not.toHaveBeenCalled();
  });

  it('hardDelete removes every match and flushes once', async () => {
    const entities: TestEntity[] = [
      { id: '1', name: 'a', deletedAt: null },
      { id: '2', name: 'b', deletedAt: null },
    ];
    vi.mocked(repo.find).mockResolvedValue(entities);

    await dao.hardDelete({ name: 'x' } as never);

    expect(em.remove).toHaveBeenCalledTimes(2);
    expect(em.remove).toHaveBeenCalledWith(entities[0]);
    expect(em.remove).toHaveBeenCalledWith(entities[1]);
    expect(em.flush).toHaveBeenCalledOnce();
  });

  it('hardDelete is a no-op when no matches found', async () => {
    vi.mocked(repo.find).mockResolvedValue([]);

    await dao.hardDelete({ name: 'x' } as never);

    expect(em.remove).not.toHaveBeenCalled();
    expect(em.flush).not.toHaveBeenCalled();
  });

  it('hardDelete with txEm uses transactional EM', async () => {
    const txRepo = createMockRepo();
    const txEm = createMockEm(txRepo);
    const entities: TestEntity[] = [{ id: '1', name: 'a', deletedAt: null }];
    vi.mocked(txRepo.find).mockResolvedValue(entities);

    await dao.hardDelete({ name: 'x' } as never, txEm);

    expect(txEm.getRepository).toHaveBeenCalledWith(TestEntity);
    expect(txEm.remove).toHaveBeenCalledWith(entities[0]);
    expect(txEm.flush).toHaveBeenCalledOnce();
    expect(em.remove).not.toHaveBeenCalled();
  });
});

/**
 * The mock describe above pins delegation wiring only — it stays green under
 * any behavior change the repository would actually make. This describe runs
 * the SAME DAO against the real sqlite driver, where the load-bearing
 * behaviors (persistence, and the `softDelete` default filter TimestampsEntity
 * declares) are observable.
 */
describe('BaseDao (real in-memory sqlite driver)', () => {
  let orm: MikroORM;
  let dao: ThingDao;

  beforeAll(async () => {
    orm = await MikroORM.init(
      defineConfig({
        dbName: ':memory:',
        entities: [Thing],
        ignoreUndefinedInQuery: true,
        allowGlobalContext: true,
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
    dao = new ThingDao(orm.em.fork());
  });

  it('create persists a row that round-trips through getById with timestamps', async () => {
    await dao.create({ id: 't1', name: 'first' });

    const found = await dao.getById('t1');
    expect(found?.name).toBe('first');
    expect(found?.createdAt).toBeInstanceOf(Date);
    expect(found?.deletedAt).toBeNull();
  });

  it('updateById persists the change and reports the affected count', async () => {
    await dao.create({ id: 't1', name: 'old' });

    expect(await dao.updateById('t1', { name: 'new' })).toBe(1);
    expect((await dao.getById('t1'))?.name).toBe('new');
    expect(await dao.updateById('missing', { name: 'x' })).toBe(0);
  });

  it('deleteById SOFT-deletes: the row vanishes from reads via the default softDelete filter', async () => {
    await dao.create({ id: 't1', name: 'a' });
    await dao.create({ id: 't2', name: 'b' });

    await dao.deleteById('t1');

    // The row still exists physically but every default read must exclude it
    // — this is the invariant the mock spec could never observe.
    expect(await dao.getById('t1')).toBeNull();
    expect(await dao.getAll({})).toHaveLength(1);
    expect(await dao.count({})).toBe(1);
  });

  it('hardDeleteById removes the row outright', async () => {
    await dao.create({ id: 't1', name: 'a' });

    await dao.hardDeleteById('t1');

    expect(await dao.getById('t1')).toBeNull();
    expect(await dao.count({})).toBe(0);
  });
});
