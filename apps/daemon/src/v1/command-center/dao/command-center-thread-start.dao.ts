import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';
import { BaseDao } from '@packages/mikroorm';

import { CommandCenterThreadStart } from '../entity/command-center-thread-start.entity';

/** `command_center_thread_starts` — the manager's cardless start requests. */
@Injectable()
export class CommandCenterThreadStartDao extends BaseDao<CommandCenterThreadStart> {
  constructor(em: EntityManager) {
    super(em, CommandCenterThreadStart);
  }

  async create(
    fields: Pick<
      CommandCenterThreadStart,
      | 'managerRunId'
      | 'projectId'
      | 'title'
      | 'brief'
      | 'agentKind'
      | 'teamSlug'
      | 'note'
      | 'watch'
      | 'requestedAt'
      | 'approvedAt'
    >,
  ): Promise<CommandCenterThreadStart> {
    const em = this.em.fork();
    const row = this.getRepo(em).create(fields, { partial: true });
    await em.flush();
    return row;
  }

  read(id: string): Promise<CommandCenterThreadStart | null> {
    return this.getRepo(this.em.fork()).findOne(
      { id },
      { disableIdentityMap: true },
    );
  }

  /** Requests still waiting on the user's Start, oldest first. */
  listWaiting(managerRunId?: string): Promise<CommandCenterThreadStart[]> {
    return this.getRepo(this.em.fork()).find(
      {
        ...(managerRunId === undefined ? {} : { managerRunId }),
        approvedAt: null,
        declinedAt: null,
        failedAt: null,
      },
      { orderBy: { requestedAt: 'asc' }, disableIdentityMap: true },
    );
  }

  /** Approved requests no drain has claimed yet, for Electron main. */
  listApproved(): Promise<CommandCenterThreadStart[]> {
    return this.getRepo(this.em.fork()).find(
      {
        approvedAt: { $ne: null },
        startingAt: null,
        failedAt: null,
      },
      { orderBy: { requestedAt: 'asc' }, disableIdentityMap: true },
    );
  }

  /** Requests a drain claimed that recorded no run: the daemon stopped mid-start. */
  listInterrupted(): Promise<CommandCenterThreadStart[]> {
    return this.getRepo(this.em.fork()).find(
      { startingAt: { $ne: null }, runId: null, failedAt: null },
      { disableIdentityMap: true },
    );
  }

  /** Started threads the manager has not heard of yet. */
  listUnreported(): Promise<CommandCenterThreadStart[]> {
    return this.getRepo(this.em.fork()).find(
      { runId: { $ne: null }, reportedAt: null },
      { disableIdentityMap: true },
    );
  }

  /** Approve a request still waiting; false when it was answered already. */
  async approve(id: string, at: Date): Promise<boolean> {
    return (
      (await this.getRepo(this.em.fork()).nativeUpdate(
        { id, approvedAt: null, declinedAt: null, failedAt: null },
        { approvedAt: at },
      )) === 1
    );
  }

  async decline(id: string, at: Date): Promise<boolean> {
    return (
      (await this.getRepo(this.em.fork()).nativeUpdate(
        { id, approvedAt: null, declinedAt: null, failedAt: null },
        { declinedAt: at },
      )) === 1
    );
  }

  /** The drain takes an approved request to start it; false when another took it first. */
  async claim(id: string, at: Date): Promise<boolean> {
    return (
      (await this.getRepo(this.em.fork()).nativeUpdate(
        { id, approvedAt: { $ne: null }, startingAt: null, failedAt: null },
        { startingAt: at },
      )) === 1
    );
  }

  /** A claimed start that made no run is handed back to the drain. */
  async release(id: string): Promise<void> {
    await this.getRepo(this.em.fork()).nativeUpdate(
      { id, runId: null },
      { startingAt: null },
    );
  }

  async recordRun(id: string, runId: string): Promise<void> {
    await this.getRepo(this.em.fork()).nativeUpdate({ id }, { runId });
  }

  async markReported(id: string, at: Date): Promise<void> {
    await this.getRepo(this.em.fork()).nativeUpdate({ id }, { reportedAt: at });
  }

  /** A request that could not start; false when it had started or ended already. */
  async fail(id: string, at: Date, failure: string): Promise<boolean> {
    return (
      (await this.getRepo(this.em.fork()).nativeUpdate(
        { id, runId: null, failedAt: null, declinedAt: null },
        { failedAt: at, failure, startingAt: null },
      )) === 1
    );
  }

  async deleteOf(managerRunId: string): Promise<void> {
    await this.getRepo(this.em.fork()).nativeDelete({ managerRunId });
  }
}
