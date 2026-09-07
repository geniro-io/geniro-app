import { describe, expect, it } from 'vitest';

import { descriptionPreview, labelColor, labelDotClass } from './task-labels';

describe('labelColor', () => {
  it('gives one label the same colour every time', () => {
    // The whole point: nothing stores a label's colour, so the same name must
    // land on the same swatch across cards, projects and restarts.
    expect(labelColor('design')).toBe(labelColor('design'));
  });

  it('spreads different labels across more than one colour', () => {
    const names = ['design', 'bug', 'infra', 'ui', 'daemon', 'docs', 'perf'];

    const distinct = new Set(names.map(labelColor));

    expect(distinct.size).toBeGreaterThan(1);
  });

  it('answers with a real palette class, never an interpolated one', () => {
    // `palette.ts` warns that Tailwind scans source text for whole class names,
    // so a `bg-group-${color}` built at runtime is never emitted and the dot
    // renders transparent. This pins that the lookup is used.
    expect(labelDotClass('design')).toMatch(/^bg-group-[a-z]+$/);
  });

  it('survives an empty label rather than indexing off the palette', () => {
    expect(labelDotClass('')).toMatch(/^bg-group-[a-z]+$/);
  });
});

describe('descriptionPreview', () => {
  it('has nothing to show for a task with no description', () => {
    expect(descriptionPreview(null)).toBeNull();
  });

  it('skips a leading heading to the first line that carries words', () => {
    // A card showing "## Context" tells the reader nothing.
    expect(
      descriptionPreview('## Context\n\nThe board needs richer cards.'),
    ).toBe('The board needs richer cards.');
  });

  it('strips the syntax that would otherwise render as punctuation', () => {
    expect(descriptionPreview('- [ ] **Wire** the `drag` handlers')).toBe(
      'Wire the drag handlers',
    );
  });

  it('says nothing rather than showing a bare code fence', () => {
    expect(descriptionPreview('```\n')).toBeNull();
  });

  it('is null for a description that is only whitespace', () => {
    expect(descriptionPreview('   \n\n  ')).toBeNull();
  });
});

describe('descriptionPreview — heading fallback', () => {
  it('falls back to the heading when the description is only a heading', () => {
    // Prose wins where there is any, but a one-line description that happens to
    // be a heading is still the only thing there is to show.
    expect(descriptionPreview('# Rewrite the drag handler')).toBe(
      'Rewrite the drag handler',
    );
  });
});
