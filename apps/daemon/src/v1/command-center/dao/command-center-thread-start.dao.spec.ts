import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { commandCenterDb } from '../__tests__/command-center-db';
import { CommandCenterThreadStartDao } from './command-center-thread-start.dao';

const MANAGER = 'manager-1';
const NOW = new Date(1_700_000_000_000);

type Db = Awaited<ReturnType<typeof commandCenterDb>>;
type Request = Parameters<CommandCenterThreadStartDao['create']>[0];

function request(over: Partial<Request> = {}): Request {
  return {
    managerRunId: MANAGER,
    projectId: 'project-1',
    title: 'Billing cache',
    brief: 'Clear the cache',
    agentKind: null,
    teamSlug: null,
    note: null,
    watch: false,
    requestedAt: NOW,
    approvedAt: null,
    ...over,
  };
}

describe('CommandCenterThreadStartDao', () => {
  let db: Db;
  let dao: CommandCenterThreadStartDao;

  beforeEach(async () => {
    db = await commandCenterDb();
    dao = new CommandCenterThreadStartDao(db.em);
  });

  afterEach(async () => {
    await db.orm.close(true);
  });

  describe('create', () => {
    it('writes the request, waiting on the user', async () => {
      const row = await dao.create(request());

      expect(await dao.read(row.id)).toMatchObject({
        managerRunId: MANAGER,
        projectId: 'project-1',
        title: 'Billing cache',
        brief: 'Clear the cache',
        approvedAt: null,
        declinedAt: null,
        startingAt: null,
        runId: null,
        failedAt: null,
      });
    });
  });

  describe('claim', () => {
    it('hands an approved request to one drain only', async () => {
      const row = await dao.create(request({ approvedAt: NOW }));

      expect(await dao.claim(row.id, NOW)).toBe(true);
      expect(await dao.claim(row.id, NOW)).toBe(false);
      expect(await dao.read(row.id)).toMatchObject({ startingAt: NOW });
    });

    it('does not hand out a request still waiting on the user', async () => {
      const row = await dao.create(request());

      expect(await dao.claim(row.id, NOW)).toBe(false);
      expect(await dao.read(row.id)).toMatchObject({ startingAt: null });
    });
  });

  describe('approve and decline', () => {
    it('answers a waiting request once, by approval', async () => {
      const row = await dao.create(request());

      expect(await dao.approve(row.id, NOW)).toBe(true);
      expect(await dao.approve(row.id, NOW)).toBe(false);
      expect(await dao.decline(row.id, NOW)).toBe(false);
      expect(await dao.read(row.id)).toMatchObject({
        approvedAt: NOW,
        declinedAt: null,
      });
    });

    it('answers a waiting request once, by decline', async () => {
      const row = await dao.create(request());

      expect(await dao.decline(row.id, NOW)).toBe(true);
      expect(await dao.decline(row.id, NOW)).toBe(false);
      expect(await dao.approve(row.id, NOW)).toBe(false);
      expect(await dao.read(row.id)).toMatchObject({
        approvedAt: null,
        declinedAt: NOW,
      });
    });

    it('refuses an answer to a request that already failed', async () => {
      const row = await dao.create(request());
      await dao.fail(row.id, NOW, 'boom');

      expect(await dao.approve(row.id, NOW)).toBe(false);
      expect(await dao.decline(row.id, NOW)).toBe(false);
      expect(await dao.read(row.id)).toMatchObject({
        approvedAt: null,
        declinedAt: null,
        failedAt: NOW,
      });
    });
  });

  describe('fail', () => {
    it('fails a waiting request with its reason', async () => {
      const row = await dao.create(request());

      expect(await dao.fail(row.id, NOW, 'boom')).toBe(true);
      expect(await dao.read(row.id)).toMatchObject({
        failedAt: NOW,
        failure: 'boom',
      });
    });

    it('refuses to fail a request that has started', async () => {
      const row = await dao.create(request({ approvedAt: NOW }));
      await dao.claim(row.id, NOW);
      await dao.recordRun(row.id, 'thread-1');

      expect(await dao.fail(row.id, NOW, 'boom')).toBe(false);
      expect(await dao.read(row.id)).toMatchObject({
        runId: 'thread-1',
        failedAt: null,
        failure: null,
      });
    });
  });
});
