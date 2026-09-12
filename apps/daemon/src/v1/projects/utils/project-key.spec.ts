import { describe, expect, it } from 'vitest';

import { projectKey, taskIdentifier } from './project-key';

/**
 * The readable half of a card's identifier.
 *
 * ASKED FOR as Linear's own scheme — "по первым буквам проекта и номер" — and
 * the point of it is that `GEN-12` says which board a card is on where a UUID
 * never will.
 */
describe('projectKey', () => {
  it('takes the initials of a multi-word name', () => {
    expect(projectKey('Simpler Case Management')).toBe('SCM');
  });

  it('takes the leading letters of a single word', () => {
    expect(projectKey('Geniro')).toBe('GEN');
  });

  it('keeps digits, so a name like `M2 Cases` stays recognisable', () => {
    expect(projectKey('M2 Cases')).toBe('MC');
    expect(projectKey('M2')).toBe('M2');
  });

  it('caps a long name rather than making an unreadable key', () => {
    expect(projectKey('One Two Three Four Five Six')).toBe('OTTF');
  });

  it('falls back rather than producing an empty key', () => {
    // An identifier of the form `-12` is worse than a generic one: it names no
    // board at all, and the number alone is not unique across projects.
    expect(projectKey('🚀')).toBe('TSK');
    expect(projectKey('— — —')).toBe('TSK');
  });

  it('romanises nothing — a key is typed and read aloud', () => {
    // A Cyrillic name yields no ASCII letters, so it takes the fallback rather
    // than a key nobody can type. Deliberate: inventing a transliteration here
    // would be a second, worse answer to a question the user can settle by
    // naming the project something else.
    expect(projectKey('Проект')).toBe('TSK');
  });
});

describe('taskIdentifier', () => {
  it('joins the two halves the one way every surface draws them', () => {
    expect(taskIdentifier('GEN', 12)).toBe('GEN-12');
  });

  it('answers null for a card the backfill has not reached', () => {
    // `GEN-0` names a card that does not exist, and a bare `-12` names no
    // board — so a caller draws nothing instead.
    expect(taskIdentifier('GEN', null)).toBeNull();
    expect(taskIdentifier('GEN', 0)).toBeNull();
    expect(taskIdentifier(null, 12)).toBeNull();
    expect(taskIdentifier('', 12)).toBeNull();
  });
});
