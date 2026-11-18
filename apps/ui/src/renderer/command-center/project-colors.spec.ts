import { describe, expect, it } from 'vitest';

import { PROFILE_COLORS } from '../../shared/contracts';
import { projectColorsOf } from './project-colors';

describe('projectColorsOf', () => {
  it('gives each project on the graph its own colour, in the order of their names', () => {
    expect(
      projectColorsOf([
        { id: 'p-web', name: 'Web' },
        { id: 'p-api', name: 'Api' },
        null,
        { id: 'p-web', name: 'Web' },
        undefined,
        { id: 'p-mobile', name: 'Mobile' },
      ]),
    ).toEqual([
      { id: 'p-api', name: 'Api', color: 'blue' },
      { id: 'p-mobile', name: 'Mobile', color: 'purple' },
      { id: 'p-web', name: 'Web', color: 'green' },
    ]);
  });

  it('keeps a project’s colour while the same projects stand on the graph, whatever order the threads come in', () => {
    const projects = [
      { id: 'b', name: 'Billing' },
      { id: 'c', name: 'Cache' },
    ];

    expect(projectColorsOf(projects)).toEqual(
      projectColorsOf([...projects].reverse()),
    );
  });

  it('tells two projects of one name apart by id, each with its own colour', () => {
    const colors = projectColorsOf([
      { id: 'z', name: 'Same' },
      { id: 'a', name: 'Same' },
    ]);

    expect(colors.map((project) => project.id)).toEqual(['a', 'z']);
    expect(colors[0]!.color).not.toBe(colors[1]!.color);
  });

  it('wraps the palette past its eighth project', () => {
    const many = Array.from({ length: PROFILE_COLORS.length + 1 }, (_, i) => ({
      id: `p${i}`,
      name: `Project ${String(i).padStart(2, '0')}`,
    }));

    const colors = projectColorsOf(many);

    expect(new Set(colors.slice(0, 8).map((p) => p.color)).size).toBe(8);
    expect(colors[8]!.color).toBe(colors[0]!.color);
  });

  it('lists nothing when no thread has a project', () => {
    expect(projectColorsOf([null, undefined])).toEqual([]);
  });
});
