import { describe, expect, it } from 'vitest';

import { parseCommandMd, parseSkillMd } from './skill-markdown';

describe('parseSkillMd', () => {
  it('reads name + description from frontmatter', () => {
    const meta = parseSkillMd(
      '---\nname: deploy\ndescription: Ship the app\n---\nBody text.',
      'dir-name',
    );
    expect(meta).toEqual({ name: 'deploy', description: 'Ship the app' });
  });

  it('falls back to the directory name when frontmatter has no usable name', () => {
    expect(parseSkillMd('---\nname: "has spaces"\n---\n', 'my-skill')).toEqual({
      name: 'my-skill',
      description: null,
    });
    expect(parseSkillMd('Just a body, no frontmatter.', 'my-skill')).toEqual({
      name: 'my-skill',
      description: null,
    });
  });

  it('returns null when neither frontmatter nor fallback is a typable token', () => {
    expect(parseSkillMd('body', 'bad name')).toBeNull();
  });

  it('never takes a description from the body — a skill body is instructions', () => {
    const meta = parseSkillMd('First body line.', 'skill');
    expect(meta?.description).toBeNull();
  });

  it('degrades malformed frontmatter YAML to no metadata instead of throwing', () => {
    const meta = parseSkillMd('---\nname: [unclosed\n---\nbody', 'fallback');
    expect(meta).toEqual({ name: 'fallback', description: null });
  });

  it('collapses whitespace and caps a runaway description', () => {
    const meta = parseSkillMd(
      `---\nname: s\ndescription: |\n  line one\n  line two ${'x'.repeat(400)}\n---\n`,
      's',
    );
    expect(meta?.description).toContain('line one line two');
    expect(meta?.description).not.toContain('\n');
    expect(meta?.description?.length).toBe(300);
    expect(meta?.description?.endsWith('…')).toBe(true);
  });
});

describe('parseCommandMd', () => {
  it('reads the description from frontmatter, name from the file stem', () => {
    const meta = parseCommandMd(
      '---\ndescription: Reviews the diff\n---\nDo a review of $ARGUMENTS.',
      'review',
    );
    expect(meta).toEqual({ name: 'review', description: 'Reviews the diff' });
  });

  it('falls back to the first non-empty body line, stripping heading markers', () => {
    const meta = parseCommandMd('\n\n## Fix the bug\nDetails…', 'fix');
    expect(meta).toEqual({ name: 'fix', description: 'Fix the bug' });
  });

  it('returns null description for an empty file', () => {
    expect(parseCommandMd('', 'empty')).toEqual({
      name: 'empty',
      description: null,
    });
  });

  it('rejects a file stem that is not a typable token', () => {
    expect(parseCommandMd('body', 'two words')).toBeNull();
  });
});
