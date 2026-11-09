import { describe, expect, it } from 'vitest';

import type { RecommendationsPatch } from '../chat.types';
import { patchedCard } from './recommendations-patch';

const HELD = {
  summary: 'kept',
  hotspots: [{ title: 'Loops', why: 're-reads the diff', items: ['W-1'] }],
  items: [
    {
      id: 'W-1',
      target: 'team',
      title: 'Parallel reviewers',
      change: 'old change',
    },
    { id: 'R-1', target: 'repo', title: 'Check', change: 'keep me' },
  ],
  members: [
    {
      member: 'reviewer',
      usefulness: 4,
      quality: 2,
      verdict: 'tune',
      items: ['W-1'],
    },
  ],
};

function cardOf(patch: RecommendationsPatch): Record<string, unknown> {
  const result = patchedCard(HELD, patch);
  expect(result.ok).toBe(true);
  return result.ok ? result.card : {};
}

describe('patchedCard', () => {
  it('drops a stray top-level key a kept card was refused for, which no patch could name', () => {
    const patched = patchedCard({ ...HELD, totals: { costUsd: 1 } }, {});
    expect(patched).toMatchObject({ ok: true });
    expect(patched.ok && patched.card).not.toHaveProperty('totals');
  });

  it('merges an entry by its id, each field sent replacing that field and the rest staying', () => {
    const card = cardOf({ items: [{ id: 'W-1', change: 'new change' }] });

    expect(card.items).toEqual([
      {
        id: 'W-1',
        target: 'team',
        title: 'Parallel reviewers',
        change: 'new change',
      },
      { id: 'R-1', target: 'repo', title: 'Check', change: 'keep me' },
    ]);
  });

  it('merges a hotspot by its title and a member by its name', () => {
    const card = cardOf({
      hotspots: [{ title: 'Loops', items: ['W-1', 'R-1'] }],
      members: [{ member: 'reviewer', quality: 5 }],
    });

    expect(card.hotspots).toEqual([
      { title: 'Loops', why: 're-reads the diff', items: ['W-1', 'R-1'] },
    ]);
    expect(card.members).toEqual([
      {
        member: 'reviewer',
        usefulness: 4,
        quality: 5,
        verdict: 'tune',
        items: ['W-1'],
      },
    ]);
  });

  it('appends a key it does not hold as a whole entry', () => {
    const card = cardOf({
      items: [{ id: 'W-2', target: 'team', title: 'New', change: 'added' }],
    });

    expect(card.items).toHaveLength(3);
    expect(card.items).toContainEqual({
      id: 'W-2',
      target: 'team',
      title: 'New',
      change: 'added',
    });
    expect(card.items).toContainEqual(HELD.items[0]);
  });

  it('takes a removed entry off the card, and names a removal of one it does not hold', () => {
    const card = cardOf({
      remove: { items: ['R-1'], hotspots: ['Loops'] },
    });

    expect(card.items).toEqual([HELD.items[0]]);
    expect(card.hotspots).toEqual([]);

    expect(patchedCard(HELD, { remove: { items: ['W-9'] } })).toEqual({
      ok: false,
      problems: ['remove names item W-9, which is not on the card'],
    });
    expect(patchedCard(HELD, { remove: { hotspots: ['Nope'] } })).toEqual({
      ok: false,
      problems: ['remove names hotspot Nope, which is not on the card'],
    });
  });

  it('replaces the summary when the patch sends one', () => {
    expect(cardOf({ summary: 'new' }).summary).toBe('new');
    expect(cardOf({}).summary).toBe('kept');
  });

  it('keeps members absent when the card has none and the patch names none', () => {
    const bare = {
      hotspots: [],
      items: HELD.items,
    };
    const result = patchedCard(bare, { summary: 'x' });

    expect(result.ok).toBe(true);
    expect(result.ok && 'members' in result.card).toBe(false);
  });

  it('does not change the card it was given', () => {
    const before = structuredClone(HELD);

    patchedCard(HELD, {
      items: [{ id: 'W-1', change: 'changed' }],
      remove: { items: ['R-1'] },
      summary: 'other',
    });

    expect(HELD).toEqual(before);
  });
});
