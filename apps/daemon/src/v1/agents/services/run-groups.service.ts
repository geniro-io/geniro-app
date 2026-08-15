import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';
import { BadRequestException, NotFoundException } from '@packages/common';

import { RunGroup } from '../../runs/entity/run-group.entity';
import {
  RUN_GROUP_COLORS,
  type RunGroupColor,
  type RunGroupWire,
} from '../chat.types';
import { RunDao } from '../dao/run.dao';
import { RunGroupDao } from '../dao/run-group.dao';
import { isWithinDirectory } from '../utils/path-within';
import { resolveValidDirectory } from '../utils/resolve-directory';

/** How many groups one sidebar may hold — a guard, not a design limit. */
const MAX_GROUPS = 100;

/**
 * The sidebar's groups: the folders a user files their chats into.
 *
 * It lives in the agents module rather than one of its own because the thing
 * being grouped is a RUN, and everything that writes `runs.group_id` is here —
 * `ChatService.createChat` stamps the auto-filing group, the assign route moves
 * a run between them, and deleting a group releases its runs through `RunDao`.
 * A separate module would need the run DAO while this one needs the group
 * service for auto-filing, and the only ways out of that cycle are a
 * `forwardRef` or relocating three DAOs the rest of the daemon resolves here.
 */
@Injectable()
export class RunGroupsService {
  constructor(
    private readonly em: EntityManager,
    private readonly groupDao: RunGroupDao,
    private readonly runDao: RunDao,
  ) {}

  async list(): Promise<RunGroupWire[]> {
    const em = this.em.fork();
    return (await this.groupDao.listOrdered(em)).map(toWire);
  }

  async create(input: {
    name: string;
    color?: RunGroupColor;
    autoCwd?: string;
  }): Promise<RunGroupWire> {
    const em = this.em.fork();
    const existing = await this.groupDao.listOrdered(em);
    if (existing.length >= MAX_GROUPS) {
      throw new BadRequestException(
        'TOO_MANY_GROUPS',
        `a sidebar holds at most ${MAX_GROUPS} groups`,
      );
    }
    const group = await this.groupDao.create(
      {
        name: input.name,
        // Not a fixed default: an unstated colour cycles through the palette by
        // how many groups already exist, so a user who never opens the picker
        // still gets a sidebar they can tell apart at a glance.
        color: input.color ?? nextColor(existing),
        autoCwd: resolveAutoCwd(input.autoCwd ?? null),
        // Appended, never inserted: a new group is the user's newest thought
        // and moving it is one click away.
        position: existing.length,
      },
      em,
    );
    return toWire(group);
  }

  /**
   * Change a group's name, colour, folded state or auto-filing folder.
   *
   * `autoCwd: null` is a real value — it clears the rule — which is the one
   * thing an omitted key cannot say. Nothing here touches the runs: renaming or
   * recolouring a folder is not a claim about what is in it, and a NEW
   * `autoCwd` deliberately does not sweep up the chats that already exist in
   * that directory. The rule is about where a chat LANDS when it is created;
   * retroactively moving conversations the user filed by hand would undo their
   * own arrangement without asking.
   */
  async update(
    groupId: string,
    patch: {
      name?: string;
      color?: RunGroupColor;
      collapsed?: boolean;
      autoCwd?: string | null;
    },
  ): Promise<RunGroupWire> {
    const em = this.em.fork();
    const group = await this.getOrThrow(groupId, em);
    if (patch.name !== undefined) {
      group.name = patch.name;
    }
    if (patch.color !== undefined) {
      group.color = patch.color;
    }
    if (patch.collapsed !== undefined) {
      group.collapsed = patch.collapsed;
    }
    if (patch.autoCwd !== undefined) {
      group.autoCwd = resolveAutoCwd(patch.autoCwd);
    }
    await em.flush();
    return toWire(group);
  }

  /**
   * Set the sidebar order outright, from the list of ids the client is now
   * showing, and answer with the whole ordered list.
   *
   * The WHOLE order rather than "move this one up": the sidebar reorders by
   * dragging, where the user's gesture produces an arrangement, not a
   * displacement. Sending the arrangement also makes the write idempotent —
   * replaying it lands on the same rows — where a relative move replayed twice
   * moves twice.
   *
   * A group the client did not name is APPENDED in its current order rather
   * than dropped: the list is a snapshot of what one window could see, and one
   * created in another (or by a request still in flight when the drag started)
   * must not lose its place because a stale client failed to mention it. An id
   * naming no group is ignored for the same reason — a delete that landed
   * mid-drag is not a reason to refuse the arrangement.
   *
   * Positions are renumbered contiguously on every call, so "the one above
   * this" is always `position - 1`, and any rows that ever came to share a
   * position are repaired by the next drag.
   */
  async reorder(ids: readonly string[]): Promise<RunGroupWire[]> {
    const em = this.em.fork();
    const groups = await this.groupDao.listOrdered(em);
    const byId = new Map(groups.map((group) => [group.id, group]));
    const named = ids
      .map((id) => byId.get(id))
      .filter((group): group is RunGroup => group !== undefined);
    const namedIds = new Set(named.map((group) => group.id));
    const ordered = [
      ...named,
      ...groups.filter((group) => !namedIds.has(group.id)),
    ];
    ordered.forEach((group, position) => {
      group.position = position;
    });
    await em.flush();
    return ordered.map(toWire);
  }

  /**
   * Delete a group and RELEASE its runs — they move out of it, not away with
   * it.
   *
   * The release happens FIRST and the row goes second: the reverse order leaves
   * a window in which a run points at a group that no longer exists, and a
   * crash inside that window makes it permanent.
   */
  async remove(groupId: string): Promise<{
    deleted: boolean;
    released: number;
  }> {
    const em = this.em.fork();
    await this.getOrThrow(groupId, em);
    const released = await this.runDao.clearGroup(groupId, em);
    await this.groupDao.hardDeleteById(groupId, em);
    return { deleted: true, released };
  }

  /** Refuse a group id that names nothing, so a bad assign 404s at the door. */
  async assertExists(groupId: string): Promise<void> {
    await this.getOrThrow(groupId, this.em.fork());
  }

  /**
   * Which group, if any, claims a new chat started in `cwd`.
   *
   * A group claims the folder it names AND everything inside it, because a user
   * who points a group at a project means the project — its packages, its
   * apps — and an exact-match-only rule would silently never fire for the very
   * chats they opened it for.
   *
   * When several claim the same run the MOST SPECIFIC wins: a group on
   * `~/work/app` beats one on `~/work`, which is the only reading under which
   * the two can usefully coexist. Sidebar order breaks a genuine tie, so the
   * answer is deterministic rather than whatever the row order happened to be.
   */
  async resolveAutoGroupId(cwd: string | null): Promise<string | null> {
    if (cwd === null) {
      return null;
    }
    const em = this.em.fork();
    const claims = (await this.groupDao.listOrdered(em)).filter(
      (group) =>
        group.autoCwd !== null && isWithinDirectory(cwd, group.autoCwd),
    );
    claims.sort(
      (a, b) =>
        (b.autoCwd?.length ?? 0) - (a.autoCwd?.length ?? 0) ||
        a.position - b.position,
    );
    return claims[0]?.id ?? null;
  }

  private async getOrThrow(
    groupId: string,
    em: EntityManager,
  ): Promise<RunGroup> {
    const group = await this.groupDao.getById(groupId, em);
    if (!group) {
      throw new NotFoundException(
        'GROUP_NOT_FOUND',
        `group ${groupId} not found`,
      );
    }
    return group;
  }
}

/**
 * Canonicalize an auto-filing folder, or keep the null that clears the rule.
 *
 * Canonical HERE, at the one moment the value is chosen, so it can be compared
 * against a run's own canonical `cwd` without either side resolving symlinks on
 * a read path. A folder that does not exist is refused rather than stored: a
 * rule that can never match is indistinguishable from a feature that does not
 * work.
 */
function resolveAutoCwd(autoCwd: string | null): string | null {
  return autoCwd === null
    ? null
    : resolveValidDirectory(autoCwd, {
        errorCode: 'AUTO_CWD_INVALID',
        noun: "the group's auto-file folder",
      });
}

/**
 * The palette hue a new group takes when the user names none — the next one
 * round, by how many groups exist. Sequential rather than random so creating
 * three groups in a row gives three different colours every time.
 */
function nextColor(existing: readonly RunGroup[]): RunGroupColor {
  return RUN_GROUP_COLORS[existing.length % RUN_GROUP_COLORS.length]!;
}

function toWire(group: RunGroup): RunGroupWire {
  return {
    id: group.id,
    name: group.name,
    color: group.color,
    position: group.position,
    collapsed: group.collapsed,
    autoCwd: group.autoCwd,
  };
}
