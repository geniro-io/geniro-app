import { setImmediate } from 'node:timers/promises';

import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';

import { type MemoryActiveText, MemoryDao } from '../dao/memory.dao';
import { MemoryReviewFindingDao } from '../dao/memory-review-finding.dao';
import type { Memory } from '../entity/memory.entity';
import {
  MEMORY_CHECK_PAIRS_LISTED_MAX,
  MEMORY_CHECK_PARTNERS,
  type MemoryCheckRecord,
  type MemoryFinding,
  type MemoryPair,
} from '../memory.types';
import {
  memoryTextHash,
  orderedPair,
  pairKey,
  rareTermsQuery,
  seenTogether,
  termsOf,
  textsKey,
} from '../utils/memory-pairs';
import { toEntry } from './memory.service';

/** Entries read, or searched for partners, between two yields of the loop. */
const WINDOW = 100;

/** A likely pair with the characters of both texts, for a cost estimate. */
export interface MemoryCandidatePair extends MemoryPair {
  chars: number;
}

/** A pair to ask about: both entries active, at the texts the check will judge. */
export interface MemoryCheckPair {
  a: Memory;
  b: Memory;
  hashA: string;
  hashB: string;
}

/**
 * The pairs of shared-memory entries likely to repeat or contradict each
 * other, and what model checks found about them. Pairs are found by words two
 * entries share that few others hold, only between entries some run sees
 * together; a pair checked at its current texts is not offered again.
 */
@Injectable()
export class MemoryFindingsService {
  constructor(
    private readonly em: EntityManager,
    private readonly memories: MemoryDao,
    private readonly findings: MemoryReviewFindingDao,
  ) {}

  /** Every likely pair not yet checked at its current texts, in a stable order. */
  async candidatePairs(): Promise<MemoryCandidatePair[]> {
    const em = this.em.fork();
    const entries = await this.readActive(em);
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    const termsById = new Map<string, Set<string>>();
    const entriesWith = new Map<string, number>();
    for (const entry of entries) {
      const terms = termsOf(entry.title, entry.body);
      termsById.set(entry.id, terms);
      for (const term of terms) {
        entriesWith.set(term, (entriesWith.get(term) ?? 0) + 1);
      }
    }
    const checked = await this.findings.checkedTexts(em);
    const hashes = new Map(
      entries.map((entry) => [
        entry.id,
        memoryTextHash(entry.title, entry.body),
      ]),
    );
    const seen = new Set<string>();
    const pairs: MemoryCandidatePair[] = [];
    for (const [n, entry] of entries.entries()) {
      if (n > 0 && n % WINDOW === 0) {
        await setImmediate();
      }
      const query = rareTermsQuery(termsById.get(entry.id)!, entriesWith);
      if (query === null) {
        continue;
      }
      const partners = await this.memories.matchIds(
        query,
        { statuses: ['active'], places: placesOf(entry) },
        MEMORY_CHECK_PARTNERS + 1,
        em,
      );
      for (const partnerId of partners
        .filter((id) => id !== entry.id)
        .slice(0, MEMORY_CHECK_PARTNERS)) {
        const partner = byId.get(partnerId);
        if (partner === undefined || !seenTogether(entry, partner)) {
          continue;
        }
        const [aId, bId] = orderedPair(entry.id, partnerId);
        const key = pairKey(aId, bId);
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        if (checked.get(key) === textsKey(hashes.get(aId)!, hashes.get(bId)!)) {
          continue;
        }
        pairs.push({
          aId,
          bId,
          chars:
            entry.title.length +
            entry.body.length +
            partner.title.length +
            partner.body.length,
        });
        if (pairs.length >= MEMORY_CHECK_PAIRS_LISTED_MAX) {
          return pairs;
        }
      }
    }
    return pairs;
  }

  /**
   * The asked pairs a check may still judge: both entries active and seen
   * together, at texts not checked yet. The rest are skipped.
   */
  async checkable(pairs: readonly MemoryPair[]): Promise<MemoryCheckPair[]> {
    const em = this.em.fork();
    const ordered = pairs.map(({ aId, bId }) => orderedPair(aId, bId));
    const rows = await this.memories.getByIds([...new Set(ordered.flat())], em);
    const byId = new Map(rows.map((row) => [row.id, row]));
    const checked = await this.findings.checkedTexts(em);
    const seen = new Set<string>();
    const result: MemoryCheckPair[] = [];
    for (const [aId, bId] of ordered) {
      const a = byId.get(aId);
      const b = byId.get(bId);
      const key = pairKey(aId, bId);
      if (
        a === undefined ||
        b === undefined ||
        aId === bId ||
        seen.has(key) ||
        a.status !== 'active' ||
        b.status !== 'active' ||
        !seenTogether(a, b)
      ) {
        continue;
      }
      seen.add(key);
      const hashA = memoryTextHash(a.title, a.body);
      const hashB = memoryTextHash(b.title, b.body);
      if (checked.get(key) === textsKey(hashA, hashB)) {
        continue;
      }
      result.push({ a, b, hashA, hashB });
    }
    return result;
  }

  /** Store what a check found and answer the findings it shows. */
  async record(checks: readonly MemoryCheckRecord[]): Promise<MemoryFinding[]> {
    const em = this.em.fork();
    const ids = await this.findings.record(checks, new Date(), em);
    return this.openFindings(em, [...ids.values()]);
  }

  /** Every finding the user has still to decide, newest check first. */
  async open(): Promise<MemoryFinding[]> {
    return this.openFindings(this.em.fork());
  }

  /**
   * Say both entries of a finding are true: it is not shown or asked again
   * until either text changes. False when there is no such finding.
   */
  async dismiss(id: string): Promise<boolean> {
    return this.findings.dismiss(id, new Date(), this.em.fork());
  }

  private async openFindings(
    em: EntityManager,
    ids?: readonly string[],
  ): Promise<MemoryFinding[]> {
    const rows = await this.findings.open(ids, em);
    if (rows.length === 0) {
      return [];
    }
    const entries = new Map(
      (
        await this.memories.getByIds(
          [...new Set(rows.flatMap((row) => [row.memoryAId, row.memoryBId]))],
          em,
        )
      ).map((row) => [row.id, row]),
    );
    return rows.flatMap((row) => {
      const a = entries.get(row.memoryAId);
      const b = entries.get(row.memoryBId);
      if (
        a === undefined ||
        b === undefined ||
        row.hashA !== memoryTextHash(a.title, a.body) ||
        row.hashB !== memoryTextHash(b.title, b.body)
      ) {
        return [];
      }
      return [
        {
          id: row.id,
          kind: row.kind,
          a: toEntry(a),
          b: toEntry(b),
          quoteA: row.quoteA,
          quoteB: row.quoteB,
          reason: row.reason,
          agentKind: row.agentKind,
          model: row.model,
          checkedAt: new Date(row.checkedAt).toISOString(),
        },
      ];
    });
  }

  private async readActive(em: EntityManager): Promise<MemoryActiveText[]> {
    const entries: MemoryActiveText[] = [];
    let after = 0;
    for (;;) {
      const window = await this.memories.activeTexts(after, WINDOW, em);
      entries.push(...window);
      if (window.length < WINDOW) {
        return entries;
      }
      after = window.at(-1)!.handle;
      await setImmediate();
    }
  }
}

function placesOf(entry: MemoryActiveText) {
  if (entry.projectId === null && entry.teamSlug === null) {
    return { any: true } as const;
  }
  return {
    visibleTo: { projectId: entry.projectId, teamSlug: entry.teamSlug },
  };
}
