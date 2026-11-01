import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@packages/common';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { member, teamOf } from '../__tests__/team-builders';
import type { Team } from '../teams.types';
import { TeamStoreService } from './team-store.service';

const WF: Team = teamOf(
  [
    member('coder'),
    member('reviewer', { agent: 'cursor-agent', approval: 'ask' }),
  ],
  { name: 'Review Team' },
);

const SOLO_YAML = (name: string, extra = ''): string =>
  `name: ${name}\nmembers:\n  - id: solo\n    name: solo\n    agent: claude\n${extra}triggers:\n  - kind: first-message\n    member: solo\n`;

describe('TeamStoreService', () => {
  let dir: string;
  let store: TeamStoreService;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'geniro-teams-'));
    store = new TeamStoreService({ teamsDir: dir });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('creates a team deriving the slug from its name', async () => {
    const created = await store.create(WF);
    expect(created.slug).toBe('review-team');
    const listed = await store.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      slug: 'review-team',
      name: 'Review Team',
      memberCount: 2,
      stageCount: 0,
    });
  });

  it('refuses a save whose stages loop back, and keeps one whose responsible member was deleted', async () => {
    await store.create(WF, 'review-team');
    await expect(
      store.save('review-team', {
        ...WF,
        stages: [
          { id: 'build', title: 'Build', goal: 'built', next: ['check'] },
          { id: 'check', title: 'Check', goal: 'ok', next: ['fix'] },
          { id: 'fix', title: 'Fix', goal: 'fixed', next: ['check'] },
        ],
      }),
    ).rejects.toMatchObject({ errorCode: 'STAGE_CYCLE' });

    await store.save('review-team', {
      ...WF,
      stages: [
        { id: 'build', title: 'Build', goal: 'built', responsible: ['gone'] },
      ],
    });
    expect(
      (await store.get('review-team')).team.stages?.[0]?.responsible,
    ).toEqual(['gone']);
  });

  it('refuses a save made from a copy older than the file, and accepts one from the current copy', async () => {
    const created = await store.create(WF, 'review-team');
    const elsewhere = await store.save('review-team', {
      ...WF,
      description: 'changed by an analysis',
    });

    await expect(
      store.save('review-team', { ...WF, name: 'Stale copy' }, created.hash),
    ).rejects.toMatchObject({ errorCode: 'TEAM_CHANGED' });
    expect((await store.get('review-team')).team.description).toBe(
      'changed by an analysis',
    );

    const saved = await store.save(
      'review-team',
      { ...WF, name: 'Fresh copy' },
      elsewhere.hash,
    );
    expect(saved.hash).toBe((await store.get('review-team')).hash);
    expect(saved.hash).not.toBe(elsewhere.hash);
  });

  it('lets only one of two saves from the same version win, even at the same moment', async () => {
    const created = await store.create(WF, 'review-team');

    const results = await Promise.allSettled([
      store.save('review-team', { ...WF, name: 'Builder' }, created.hash),
      store.save('review-team', { ...WF, name: 'Analysis' }, created.hash),
    ]);

    expect(results.map((result) => result.status)).toEqual([
      'fulfilled',
      'rejected',
    ]);
    expect((await store.get('review-team')).team.name).toBe('Builder');
  });

  it('refuses a save quoting a version of a file deleted since, and does not re-create it', async () => {
    const created = await store.create(WF, 'review-team');
    await store.delete('review-team');

    await expect(
      store.save('review-team', WF, created.hash),
    ).rejects.toMatchObject({ errorCode: 'TEAM_CHANGED' });
    expect(await store.list()).toEqual([]);
  });

  it('summarizes the per-agent-kind breakdown in a stable order', async () => {
    // The card badges read agentCounts directly — assert it is a real tally
    // (three same-kind members count as 3, not deduped to 1) and that the order
    // follows TEAM_AGENT_KINDS (claude first) regardless of declaration
    // order, so a card's badges don't reshuffle between listings.
    await store.create(
      teamOf(
        [
          member('a', { agent: 'cursor-agent' }),
          member('b'),
          member('c'),
          member('d'),
        ],
        { name: 'Mixed Team' },
      ),
    );
    const [summary] = await store.list();
    expect(summary?.agentCounts).toEqual([
      { kind: 'claude', count: 3 },
      { kind: 'cursor-agent', count: 1 },
    ]);
    expect(summary?.memberCount).toBe(4);
  });

  it('counts the stages of a team in stageCount', async () => {
    await store.create({
      ...WF,
      stages: [
        { id: 'build', title: 'Build', goal: 'built', next: ['check'] },
        { id: 'check', title: 'Check', goal: 'ok' },
      ],
    });
    const [summary] = await store.list();
    expect(summary).toMatchObject({ memberCount: 2, stageCount: 2 });
  });

  it('lists teams newest-updated first', async () => {
    // Deliberately make the ALPHABETICALLY-FIRST slug the OLDER file: an
    // alphabetical sort would return ['alpha', 'beta'], so this only passes
    // when the ordering truly follows the modification time.
    await store.create({ ...WF, name: 'Alpha' });
    await store.create({ ...WF, name: 'Beta' });
    await utimes(
      join(dir, 'alpha.team.yaml'),
      new Date(),
      new Date('2026-01-01T00:00:00Z'),
    );
    await utimes(
      join(dir, 'beta.team.yaml'),
      new Date(),
      new Date('2026-06-01T00:00:00Z'),
    );

    const slugs = (await store.list()).map((s) => s.slug);
    expect(slugs).toEqual(['beta', 'alpha']);
  });

  it('refuses to create or save a team with no members, and writes nothing', async () => {
    const empty = teamOf([], { name: 'Blank' });

    await expect(store.create(empty)).rejects.toMatchObject({
      errorCode: 'TEAM_NO_MEMBERS',
    });
    await expect(store.save('blank', empty)).rejects.toMatchObject({
      errorCode: 'TEAM_NO_MEMBERS',
    });
    expect(await readdir(dir)).toEqual([]);
  });

  it('validates a team on create and on save with the team rules', async () => {
    const noTrigger = { ...WF, triggers: [] };
    const unknownTrigger: Team = {
      ...WF,
      triggers: [{ kind: 'first-message', member: 'ghost' }],
    };
    const twice = teamOf([member('coder'), member('coder')]);

    await expect(store.create(noTrigger)).rejects.toMatchObject({
      errorCode: 'TEAM_TRIGGER_COUNT',
    });
    await expect(store.create(unknownTrigger)).rejects.toMatchObject({
      errorCode: 'TEAM_TRIGGER_UNKNOWN',
    });
    await expect(store.save('team', twice)).rejects.toMatchObject({
      errorCode: 'TEAM_DUPLICATE_MEMBER',
    });
    expect(await readdir(dir)).toEqual([]);
  });

  it('suffixes the slug when the name collides', async () => {
    await store.create(WF);
    const second = await store.create(WF);
    expect(second.slug).toBe('review-team-2');
  });

  it('names the slug a create would derive without writing a file', async () => {
    await expect(store.freeDerivedSlug('Review Team')).resolves.toBe(
      'review-team',
    );
    await expect(readdir(dir)).resolves.toEqual([]);
    await store.create(WF);
    await expect(store.freeDerivedSlug('Review Team')).resolves.toBe(
      'review-team-2',
    );
    await expect(store.freeDerivedSlug('Runs')).resolves.toBe('runs-1');
    expect((await store.list()).map((w) => w.slug)).toEqual(['review-team']);
  });

  it('never lets concurrent creates with the same name silently share one file', async () => {
    // Rapid concurrent creates (e.g. a double-clicked "New team" button)
    // race through the derive-slug → exists-check → write sequence. Every
    // create must either succeed owning a distinct file that still holds the
    // team it was given, or reject with the TEAM_EXISTS conflict —
    // never silently overwrite / interleave another create's file. All
    // violation modes of that one contract are collected into a single
    // assertion because which mode manifests depends on fs scheduling.
    const copies: Team[] = [1, 2, 3].map((n) => ({
      ...WF,
      description: `copy ${n}`,
    }));
    const results = await Promise.allSettled(
      copies.map((wf) => store.create(wf)),
    );
    const violations: string[] = [];
    const slugs: string[] = [];
    for (const [i, result] of results.entries()) {
      if (result.status === 'rejected') {
        if (!(result.reason instanceof ConflictException)) {
          violations.push(
            `create of copy ${i + 1} rejected with a non-conflict error: ${String(result.reason)}`,
          );
        }
        continue;
      }
      const { slug, team } = result.value;
      if (slugs.includes(slug)) {
        violations.push(`two successful creates share the slug '${slug}'`);
      }
      slugs.push(slug);
      const got = await store.get(slug).catch((err: unknown) => {
        violations.push(`get('${slug}') failed after create: ${String(err)}`);
        return null;
      });
      if (got && got.team.description !== team.description) {
        violations.push(
          `'${slug}' holds '${String(got.team.description)}' instead of '${String(team.description)}'`,
        );
      }
    }
    if ((await store.list()).length !== slugs.length) {
      violations.push('library file count differs from successful creates');
    }
    expect(slugs.length).toBeGreaterThanOrEqual(1);
    expect(violations).toEqual([]);
  });

  it('can get() every team that list() returns, including hand-copied files with non-slug names', async () => {
    // The teams dir is a plain folder under userData — a user can drop a
    // hand-written file in with a name outside the slug charset. Whatever
    // list() decides to show must be openable: a listed slug that get()
    // rejects is a team the UI displays but can never open.
    await store.save('good', WF);
    await writeFile(
      join(dir, 'My-Team.team.yaml'),
      SOLO_YAML('my team'),
      'utf8',
    );
    const listed = await store.list();
    expect(listed.length).toBeGreaterThanOrEqual(1);
    for (const summary of listed) {
      const got = await store.get(summary.slug);
      expect(got.team.name).toBe(summary.name);
    }
  });

  describe('a slug a ROUTE owns is never handed to a team', () => {
    // A team named "Runs" would slugify to `runs`, and
    // `GET /v1/teams/runs` is the run list — Fastify matches the static
    // segment first, so the team would list and could never be opened.
    it('derives `runs-1` for a team named "Runs"', async () => {
      const created = await store.create({ ...WF, name: 'Runs' });
      expect(created.slug).toBe('runs-1');
      await expect(store.get('runs-1')).resolves.toMatchObject({
        team: { name: 'Runs' },
      });
    });

    it('steps past a taken `runs-1` to `runs-2`, never back to `runs`', async () => {
      const first = await store.create({ ...WF, name: 'Runs' });
      const second = await store.create({ ...WF, name: 'runs' });
      expect([first.slug, second.slug]).toEqual(['runs-1', 'runs-2']);
    });

    it('reserves `import` the same way', async () => {
      const created = await store.create({ ...WF, name: 'Import' });
      expect(created.slug).toBe('import-1');
    });

    it('imports a file named runs.team.yaml under `runs-1`', async () => {
      const outside = await mkdtemp(join(tmpdir(), 'geniro-import-'));
      const external = join(outside, 'runs.team.yaml');
      await writeFile(external, SOLO_YAML('runs'), 'utf8');
      try {
        const imported = await store.importFrom(external);
        expect(imported.slug).toBe('runs-1');
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });

    it('takes the slug from a file named before the rename (`*.geniro.yaml`)', async () => {
      const outside = await mkdtemp(join(tmpdir(), 'geniro-import-'));
      const external = join(outside, 'review-squad.geniro.yaml');
      await writeFile(external, SOLO_YAML('Something Else'), 'utf8');
      try {
        const imported = await store.importFrom(external);
        expect(imported.slug).toBe('review-squad');
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });

    it('refuses an EXPLICIT reserved slug rather than landing it elsewhere', async () => {
      await expect(store.create(WF, 'runs')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(await readdir(dir)).toEqual([]);
    });
  });

  // Import is how a team written by SOMEBODY ELSE arrives, which is the
  // case the refusal exists for: a NUL in instructions reaches claude's argv and
  // node refuses to spawn, so the member would fail every run.
  it('refuses to import a team whose member instructions carry a NUL', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'geniro-import-'));
    const external = join(outside, 'hostile.team.yaml');
    await writeFile(
      external,
      SOLO_YAML('hostile', '    instructions: "be \\0 helpful"\n'),
      'utf8',
    );
    try {
      await expect(store.importFrom(external)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(await readdir(dir)).toEqual([]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('conflicts on an explicit duplicate slug', async () => {
    await store.create(WF, 'team');
    await expect(store.create(WF, 'team')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('round-trips get after save', async () => {
    await store.save('team', WF);
    const got = await store.get('team');
    expect(got.team).toEqual(WF);
  });

  it('save preserves hand-written comments in the existing file', async () => {
    await store.save('team', WF);
    const path = join(dir, 'team.team.yaml');
    const annotated = `# my precious team\n${await readFile(path, 'utf8')}`;
    await writeFile(path, annotated, 'utf8');

    const updated: Team = {
      ...WF,
      members: [{ ...WF.members[0]!, model: 'opus' }, WF.members[1]!],
    };
    await store.save('team', updated);
    const source = await readFile(path, 'utf8');
    expect(source).toContain('# my precious team');
    expect((await store.get('team')).team.members[0]?.model).toBe('opus');
  });

  it('rejects a team that fails validation before touching disk', async () => {
    const broken: Team = {
      ...WF,
      triggers: [{ kind: 'first-message', member: 'nobody' }],
    };
    await expect(store.save('team', broken)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(store.get('team')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects a path-traversal slug', async () => {
    await expect(store.get('../evil')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('deletes a team and 404s afterwards', async () => {
    await store.save('team', WF);
    await store.delete('team');
    await expect(store.get('team')).rejects.toBeInstanceOf(NotFoundException);
    await expect(store.delete('team')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('skips unreadable files in list without failing the listing', async () => {
    await store.save('good', WF);
    await writeFile(join(dir, 'broken.team.yaml'), 'nodes: [\nname: :', 'utf8');
    const listed = await store.list();
    expect(listed.map((s) => s.slug)).toEqual(['good']);
  });

  it('refuses to import a node graph whose converted team would not load', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'geniro-import-'));
    const external = join(outside, 'long.team.yaml');
    await writeFile(
      external,
      [
        'name: Long',
        'nodes:',
        '  - { id: t, kind: trigger, trigger: manual }',
        `  - { id: a, kind: agent, agent: claude, approval: auto, name: ${'x'.repeat(81)} }`,
        'edges:',
        '  - { from: t, to: a, kind: data }',
        '',
      ].join('\n'),
      'utf8',
    );
    try {
      await expect(store.importFrom(external)).rejects.toMatchObject({
        errorCode: 'TEAM_YAML_INVALID',
      });
      expect(await readdir(dir)).toEqual([]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('imports an external file verbatim under a unique slug', async () => {
    const external = join(dir, '..', `external-${Date.now()}.team.yaml`);
    await writeFile(
      external,
      `# imported with comments\n${SOLO_YAML('ext')}`,
      'utf8',
    );
    try {
      const imported = await store.importFrom(external);
      expect(imported.team.name).toBe('ext');
      const path = join(dir, `${imported.slug}.team.yaml`);
      expect(await readFile(path, 'utf8')).toContain(
        '# imported with comments',
      );
    } finally {
      await rm(external, { force: true });
    }
  });

  it('a second import of the same name lands on the next suffix, never over the first', async () => {
    const external = join(dir, '..', `twice-${Date.now()}.team.yaml`);
    await writeFile(external, SOLO_YAML('twice'), 'utf8');
    try {
      const first = await store.importFrom(external);
      const second = await store.importFrom(external);
      expect(second.slug).not.toBe(first.slug);
      expect(second.slug).toBe(`${first.slug}-2`);
    } finally {
      await rm(external, { force: true });
    }
  });

  it('import commits exclusively — a taken path the stat check cannot see still yields a fresh slug', async () => {
    // A dangling symlink occupies the slug's path but stat() (which follows
    // symlinks) reports it absent. A check-then-rename import would "verify"
    // the slug free and silently replace the entry; the exclusive link commit
    // gets EEXIST and retries the next suffix instead.
    const external = join(dir, '..', `occupied-${Date.now()}.team.yaml`);
    await writeFile(external, SOLO_YAML('occupied'), 'utf8');
    try {
      const base = external.split('/').pop()!.replace('.team.yaml', '');
      await symlink(
        join(dir, 'nowhere-target'),
        join(dir, `${base}.team.yaml`),
      );
      const imported = await store.importFrom(external);
      expect(imported.slug).toBe(`${base}-2`);
    } finally {
      await rm(external, { force: true });
    }
  });

  it('a failed save leaves no stranded .tmp staging file behind', async () => {
    // Force the rename to fail: the target path is an existing directory. The
    // staged tmp has a unique per-call name, so nothing else ever reclaims it —
    // the write path itself must clean up on failure.
    await mkdir(join(dir, 'blocked.team.yaml'));

    await expect(store.save('blocked', WF)).rejects.toThrow();

    const entries = await readdir(dir);
    expect(entries.filter((e) => e.includes('.tmp'))).toEqual([]);
  });

  it('exports a team byte-for-byte to a target path', async () => {
    await store.save('team', WF);
    const target = join(dir, 'exported-copy.yaml');
    await store.exportTo('team', target);
    expect(await readFile(target, 'utf8')).toBe(
      await readFile(join(dir, 'team.team.yaml'), 'utf8'),
    );
  });

  describe('node-graph files', () => {
    const GRAPH_SOURCE = [
      '# the graph the team was',
      'name: Graph Team',
      'nodes:',
      '  - id: start',
      '    kind: trigger',
      '  - id: coder',
      '    kind: agent',
      '    agent: claude',
      '    description: writes the code',
      '    role: be careful',
      '  - id: reviewer',
      '    kind: agent',
      '    agent: cursor-agent',
      'edges:',
      '  - from: start',
      '    to: coder',
      '    kind: data',
      '  - from: coder',
      '    to: reviewer',
      '    kind: call',
      '',
    ].join('\n');

    it('importFrom converts a graph-shaped .geniro.yaml and writes the team shape', async () => {
      const outside = await mkdtemp(join(tmpdir(), 'geniro-import-'));
      const external = join(outside, 'graph-squad.geniro.yaml');
      await writeFile(external, GRAPH_SOURCE, 'utf8');
      try {
        const imported = await store.importFrom(external);

        expect(imported.slug).toBe('graph-squad');
        expect(imported.team).toMatchObject({
          name: 'Graph Team',
          mode: 'lead',
          members: [
            {
              id: 'coder',
              name: 'coder',
              role: 'writes the code',
              instructions: 'be careful',
            },
            { id: 'reviewer', agent: 'cursor-agent' },
          ],
          triggers: [{ kind: 'first-message', member: 'coder' }],
        });
        const written = await readFile(
          join(dir, 'graph-squad.team.yaml'),
          'utf8',
        );
        expect(written).toContain('members:');
        expect(written).not.toContain('nodes:');
        expect(written).not.toContain('edges:');
        expect((await store.get('graph-squad')).team).toEqual(imported.team);
        expect(await readFile(external, 'utf8')).toBe(GRAPH_SOURCE);
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });

    it('get() and list() read a graph-shaped library file as the converted team, leaving the file as written', async () => {
      const path = join(dir, 'graph.team.yaml');
      await writeFile(path, GRAPH_SOURCE, 'utf8');

      expect((await store.get('graph')).team).toMatchObject({
        members: [{ id: 'coder' }, { id: 'reviewer' }],
        triggers: [{ member: 'coder' }],
      });
      expect(await store.list()).toMatchObject([
        { slug: 'graph', memberCount: 2, stageCount: 0 },
      ]);
      expect(await readFile(path, 'utf8')).toBe(GRAPH_SOURCE);
    });

    // A library file written before node/edge kinds existed — no `kind` on
    // either. The store no longer normalizes these in place: the strict schema
    // rejects them outright (parseLegacyTeamYaml + the .bak retry are gone),
    // and no backup is ever minted.
    const LEGACY_SOURCE = [
      '# hand-written header comment',
      'name: Legacy Team',
      'nodes:',
      '  - id: coder',
      '    agent: claude',
      '  - id: reviewer',
      '    agent: cursor-agent',
      'edges:',
      '  - from: coder',
      '    to: reviewer',
      '',
    ].join('\n');

    it('get() rejects a legacy file instead of normalizing it, and mints no .bak', async () => {
      const path = join(dir, 'legacy.team.yaml');
      await writeFile(path, LEGACY_SOURCE, 'utf8');

      await expect(store.get('legacy')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      // The file is left exactly as the user wrote it — no in-place rewrite...
      expect(await readFile(path, 'utf8')).toBe(LEGACY_SOURCE);
      // ...and no backup exists for a normalization that no longer happens.
      await expect(readFile(`${path}.bak`, 'utf8')).rejects.toThrow();
    });

    it('list() skips a legacy file as unreadable and never mints a .bak', async () => {
      await writeFile(join(dir, 'legacy.team.yaml'), LEGACY_SOURCE, 'utf8');

      // A strict-rejected file is skipped from the listing (not normalized in).
      expect((await store.list()).map((s) => s.slug)).toEqual([]);
      await expect(
        readFile(join(dir, 'legacy.team.yaml.bak'), 'utf8'),
      ).rejects.toThrow();
    });

    it('importFrom rejects a legacy external file and adds nothing to the library', async () => {
      const external = join(dir, '..', `legacy-ext-${Date.now()}.team.yaml`);
      await writeFile(external, LEGACY_SOURCE, 'utf8');
      try {
        await expect(store.importFrom(external)).rejects.toBeInstanceOf(
          BadRequestException,
        );
        // Nothing landed in the library, and the user's original is untouched.
        expect((await store.list()).map((s) => s.slug)).toEqual([]);
        expect(await readFile(external, 'utf8')).toBe(LEGACY_SOURCE);
      } finally {
        await rm(external, { force: true });
      }
    });
  });
});

describe('TeamStoreService — locate', () => {
  let dir: string;
  let store: TeamStoreService;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'geniro-teams-'));
    store = new TeamStoreService({ teamsDir: dir });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('names the library directory and the team file inside it', async () => {
    const { slug } = await store.create(WF);
    expect(store.locate(slug)).toEqual({
      directory: dir,
      path: join(dir, `${slug}.team.yaml`),
    });
  });

  it('answers for a slug with no file yet — it is path arithmetic, not a read', () => {
    expect(store.locate('not-created').path).toBe(
      join(dir, 'not-created.team.yaml'),
    );
  });

  it('refuses a slug that would escape the library directory', () => {
    expect(() => store.locate('../../etc/passwd')).toThrow(BadRequestException);
  });
});
