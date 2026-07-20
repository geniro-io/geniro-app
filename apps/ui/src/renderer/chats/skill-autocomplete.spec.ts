import { describe, expect, it } from 'vitest';

import type { AgentSkill } from '../../shared/contracts';
import {
  applySkill,
  filterSkills,
  mergeSkills,
  slashQuery,
} from './skill-autocomplete';

function skill(name: string, overrides: Partial<AgentSkill> = {}): AgentSkill {
  return {
    name,
    description: null,
    kind: 'command',
    source: 'project',
    ...overrides,
  };
}

describe('slashQuery', () => {
  it('parses the query of an input that is one slash token being typed', () => {
    expect(slashQuery('/')).toBe('');
    expect(slashQuery('/de')).toBe('de');
  });

  it('is closed for arguments, leading text, or a non-slash input', () => {
    expect(slashQuery('/deploy now')).toBeNull();
    expect(slashQuery('hey /deploy')).toBeNull();
    expect(slashQuery('')).toBeNull();
    // The applySkill contract: the inserted trailing space closes the menu.
    expect(slashQuery('/deploy ')).toBeNull();
  });
});

describe('filterSkills', () => {
  it('ranks prefix matches before substring matches, case-insensitively', () => {
    const skills = [skill('code-review'), skill('review'), skill('Deploy')];
    expect(filterSkills(skills, 'rev').map((s) => s.name)).toEqual([
      'review',
      'code-review',
    ]);
    expect(filterSkills(skills, 'dep').map((s) => s.name)).toEqual(['Deploy']);
    expect(filterSkills(skills, 'zzz')).toEqual([]);
  });

  it('matches everything on the empty query (a bare "/")', () => {
    const skills = [skill('b'), skill('a')];
    expect(filterSkills(skills, '')).toEqual(skills);
  });
});

describe('applySkill', () => {
  it('yields the token plus a trailing space, ready for arguments', () => {
    expect(applySkill(skill('deploy'))).toBe('/deploy ');
  });
});

describe('mergeSkills', () => {
  it('unions lists sorted by name; the first list wins a name clash', () => {
    const claude = [skill('deploy', { description: 'from claude' })];
    const cursor = [
      skill('deploy', { description: 'from cursor' }),
      skill('audit'),
    ];
    expect(mergeSkills([claude, cursor])).toEqual([
      skill('audit'),
      skill('deploy', { description: 'from claude' }),
    ]);
  });
});
