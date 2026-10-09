import {
  EntityManager,
  UniqueConstraintViolationException,
} from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';
import { BaseDao } from '@packages/mikroorm';

import { LineBaseline } from '../entity/line-baseline.entity';

/** The baseline commit each folder and branch is measured against (see the entity). */
@Injectable()
export class LineBaselineDao extends BaseDao<LineBaseline> {
  constructor(em: EntityManager) {
    super(em, LineBaseline);
  }

  /** The commit a folder is measured against, or null when none is recorded yet. */
  async baseShaOf(
    folderKey: string,
    txEm?: EntityManager,
  ): Promise<string | null> {
    const row = await this.getRepo(txEm).findOne(
      { folderKey },
      { fields: ['baseSha'], disableIdentityMap: true },
    );
    return row?.baseSha ?? null;
  }

  /**
   * Record a folder's first baseline. Two threads measured at once can both find none; the
   * unique index refuses the second, which then reads the first one's back.
   *
   * @returns the baseline now recorded, whichever writer set it.
   */
  async setIfAbsent(
    row: {
      folderKey: string;
      root: string;
      branch: string | null;
      baseSha: string;
    },
    txEm?: EntityManager,
  ): Promise<string | null> {
    try {
      await this.getRepo(txEm).insert(Object.assign(new LineBaseline(), row));
      return row.baseSha;
    } catch (err) {
      if (err instanceof UniqueConstraintViolationException) {
        return this.baseShaOf(row.folderKey, txEm);
      }
      throw err;
    }
  }

  /**
   * Replace a baseline the folder can no longer be measured from — only if it is still the
   * one the caller found stale, so two threads reporting the same stale baseline replace it
   * once and the second reads the first one's replacement back.
   *
   * @returns the baseline now recorded.
   */
  async replaceIfCurrent(
    folderKey: string,
    staleSha: string,
    nextSha: string,
    txEm?: EntityManager,
  ): Promise<string | null> {
    const changed = await this.getRepo(txEm).nativeUpdate(
      { folderKey, baseSha: staleSha },
      { baseSha: nextSha },
    );
    return changed > 0 ? nextSha : this.baseShaOf(folderKey, txEm);
  }
}
