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

import type { Workflow } from '../graphs.types';
import { WorkflowStoreService } from './workflow-store.service';

const WF: Workflow = {
  name: 'Review Team',
  nodes: [
    { id: 'coder', kind: 'agent', agent: 'claude', approval: 'auto' },
    { id: 'reviewer', kind: 'agent', agent: 'cursor-agent', approval: 'ask' },
  ],
  edges: [{ from: 'coder', to: 'reviewer', kind: 'data' as const }],
};

describe('WorkflowStoreService', () => {
  let dir: string;
  let store: WorkflowStoreService;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'geniro-workflows-'));
    store = new WorkflowStoreService({ workflowsDir: dir });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('creates a workflow deriving the slug from its name', async () => {
    const created = await store.create(WF);
    expect(created.slug).toBe('review-team');
    const listed = await store.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      slug: 'review-team',
      name: 'Review Team',
      nodeCount: 2,
      edgeCount: 1,
    });
  });

  it('summarizes the per-agent-kind breakdown in a stable order', async () => {
    // The card badges read agentCounts directly — assert it is a real tally
    // (three same-kind nodes count as 3, not deduped to 1) and that the order
    // follows WORKFLOW_AGENT_KINDS (claude first) regardless of declaration
    // order, so a card's badges don't reshuffle between listings.
    await store.create({
      name: 'Mixed Team',
      nodes: [
        { id: 'a', kind: 'agent', agent: 'cursor-agent', approval: 'auto' },
        { id: 'b', kind: 'agent', agent: 'claude', approval: 'auto' },
        { id: 'c', kind: 'agent', agent: 'claude', approval: 'auto' },
        { id: 'd', kind: 'agent', agent: 'claude', approval: 'auto' },
      ],
      edges: [],
    });
    const [summary] = await store.list();
    expect(summary.agentCounts).toEqual([
      { kind: 'claude', count: 3 },
      { kind: 'cursor-agent', count: 1 },
    ]);
    expect(summary.edgeCount).toBe(0);
  });

  it('counts trigger nodes in nodeCount but never in agentCounts', async () => {
    await store.create({
      name: 'Triggered',
      nodes: [
        { id: 't', kind: 'trigger', trigger: 'manual' },
        { id: 'a', kind: 'agent', agent: 'claude', approval: 'auto' },
      ],
      edges: [{ from: 't', to: 'a', kind: 'data' as const }],
    });
    const [summary] = await store.list();
    expect(summary!.nodeCount).toBe(2);
    expect(summary!.agentCounts).toEqual([{ kind: 'claude', count: 1 }]);
  });

  it('lists workflows newest-updated first', async () => {
    // Deliberately make the ALPHABETICALLY-FIRST slug the OLDER file: an
    // alphabetical sort would return ['alpha', 'beta'], so this only passes
    // when the ordering truly follows the modification time.
    await store.create({ ...WF, name: 'Alpha' });
    await store.create({ ...WF, name: 'Beta' });
    await utimes(
      join(dir, 'alpha.geniro.yaml'),
      new Date(),
      new Date('2026-01-01T00:00:00Z'),
    );
    await utimes(
      join(dir, 'beta.geniro.yaml'),
      new Date(),
      new Date('2026-06-01T00:00:00Z'),
    );

    const slugs = (await store.list()).map((s) => s.slug);
    expect(slugs).toEqual(['beta', 'alpha']);
  });

  it('accepts an empty workflow as a library draft', async () => {
    // "New workflow" persists a blank canvas (no nodes) before the builder
    // opens — the store must round-trip it; only RUNNING it is rejected
    // (graph-executor's GRAPH_EMPTY).
    const created = await store.create({ name: 'Blank', nodes: [], edges: [] });
    const { workflow } = await store.get(created.slug);
    expect(workflow.nodes).toEqual([]);
    const [summary] = await store.list();
    expect(summary).toMatchObject({ nodeCount: 0, edgeCount: 0 });
  });

  it('suffixes the slug when the name collides', async () => {
    await store.create(WF);
    const second = await store.create(WF);
    expect(second.slug).toBe('review-team-2');
  });

  it('never lets concurrent creates with the same name silently share one file', async () => {
    // Rapid concurrent creates (e.g. a double-clicked "New workflow" button)
    // race through the derive-slug → exists-check → write sequence. Every
    // create must either succeed owning a distinct file that still holds the
    // workflow it was given, or reject with the WORKFLOW_EXISTS conflict —
    // never silently overwrite / interleave another create's file. All
    // violation modes of that one contract are collected into a single
    // assertion because which mode manifests depends on fs scheduling.
    const copies: Workflow[] = [1, 2, 3].map((n) => ({
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
      const { slug, workflow } = result.value;
      if (slugs.includes(slug)) {
        violations.push(`two successful creates share the slug '${slug}'`);
      }
      slugs.push(slug);
      const got = await store.get(slug).catch((err: unknown) => {
        violations.push(`get('${slug}') failed after create: ${String(err)}`);
        return null;
      });
      if (got && got.workflow.description !== workflow.description) {
        violations.push(
          `'${slug}' holds '${String(got.workflow.description)}' instead of '${String(workflow.description)}'`,
        );
      }
    }
    if ((await store.list()).length !== slugs.length) {
      violations.push('library file count differs from successful creates');
    }
    expect(slugs.length).toBeGreaterThanOrEqual(1);
    expect(violations).toEqual([]);
  });

  it('can get() every workflow that list() returns, including hand-copied files with non-slug names', async () => {
    // The workflows dir is a plain folder under userData — a user can drop a
    // hand-written file in with a name outside the slug charset. Whatever
    // list() decides to show must be openable: a listed slug that get()
    // rejects is a workflow the UI displays but can never open.
    await store.save('good', WF);
    await writeFile(
      join(dir, 'My-Team.geniro.yaml'),
      'name: my team\nnodes:\n  - id: solo\n    kind: agent\n    agent: claude\n',
      'utf8',
    );
    const listed = await store.list();
    expect(listed.length).toBeGreaterThanOrEqual(1);
    for (const summary of listed) {
      const got = await store.get(summary.slug);
      expect(got.workflow.name).toBe(summary.name);
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
    expect(got.workflow).toEqual(WF);
  });

  it('save preserves hand-written comments in the existing file', async () => {
    await store.save('team', WF);
    const path = join(dir, 'team.geniro.yaml');
    const annotated = `# my precious team\n${await readFile(path, 'utf8')}`;
    await writeFile(path, annotated, 'utf8');

    const updated: Workflow = {
      ...WF,
      nodes: [{ ...WF.nodes[0]!, model: 'opus' }, WF.nodes[1]!],
    };
    await store.save('team', updated);
    const source = await readFile(path, 'utf8');
    expect(source).toContain('# my precious team');
    expect((await store.get('team')).workflow.nodes[0]!.model).toBe('opus');
  });

  it('rejects a cyclic workflow before touching disk', async () => {
    const cyclic: Workflow = {
      ...WF,
      edges: [
        { from: 'coder', to: 'reviewer', kind: 'data' as const },
        { from: 'reviewer', to: 'coder', kind: 'data' as const },
      ],
    };
    await expect(store.save('team', cyclic)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(store.get('team')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects a path-traversal slug', async () => {
    await expect(store.get('../evil')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('deletes a workflow and 404s afterwards', async () => {
    await store.save('team', WF);
    await store.delete('team');
    await expect(store.get('team')).rejects.toBeInstanceOf(NotFoundException);
    await expect(store.delete('team')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('skips unreadable files in list without failing the listing', async () => {
    await store.save('good', WF);
    await writeFile(
      join(dir, 'broken.geniro.yaml'),
      'nodes: [\nname: :',
      'utf8',
    );
    const listed = await store.list();
    expect(listed.map((s) => s.slug)).toEqual(['good']);
  });

  it('imports an external file verbatim under a unique slug', async () => {
    const external = join(dir, '..', `external-${Date.now()}.geniro.yaml`);
    await writeFile(
      external,
      `# imported with comments\nname: ext\nnodes:\n  - id: solo\n    kind: agent\n    agent: claude\n`,
      'utf8',
    );
    try {
      const imported = await store.importFrom(external);
      expect(imported.workflow.name).toBe('ext');
      const path = join(dir, `${imported.slug}.geniro.yaml`);
      expect(await readFile(path, 'utf8')).toContain(
        '# imported with comments',
      );
    } finally {
      await rm(external, { force: true });
    }
  });

  it('a second import of the same name lands on the next suffix, never over the first', async () => {
    const external = join(dir, '..', `twice-${Date.now()}.geniro.yaml`);
    await writeFile(
      external,
      `name: twice\nnodes:\n  - id: solo\n    kind: agent\n    agent: claude\n`,
      'utf8',
    );
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
    const external = join(dir, '..', `occupied-${Date.now()}.geniro.yaml`);
    await writeFile(
      external,
      `name: occupied\nnodes:\n  - id: solo\n    kind: agent\n    agent: claude\n`,
      'utf8',
    );
    try {
      const base = external.split('/').pop()!.replace('.geniro.yaml', '');
      await symlink(
        join(dir, 'nowhere-target'),
        join(dir, `${base}.geniro.yaml`),
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
    await mkdir(join(dir, 'blocked.geniro.yaml'));

    await expect(store.save('blocked', WF)).rejects.toThrow();

    const entries = await readdir(dir);
    expect(entries.filter((e) => e.includes('.tmp'))).toEqual([]);
  });

  it('exports a workflow byte-for-byte to a target path', async () => {
    await store.save('team', WF);
    const target = join(dir, 'exported-copy.yaml');
    await store.exportTo('team', target);
    expect(await readFile(target, 'utf8')).toBe(
      await readFile(join(dir, 'team.geniro.yaml'), 'utf8'),
    );
  });

  describe('legacy (pre-kind) files are rejected — no normalization (no-backcompat)', () => {
    // A library file written before node/edge kinds existed — no `kind` on
    // either. The store no longer normalizes these in place: the strict schema
    // rejects them outright (parseLegacyWorkflowYaml + the .bak retry are gone),
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
      const path = join(dir, 'legacy.geniro.yaml');
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
      await writeFile(join(dir, 'legacy.geniro.yaml'), LEGACY_SOURCE, 'utf8');

      // A strict-rejected file is skipped from the listing (not normalized in).
      expect((await store.list()).map((s) => s.slug)).toEqual([]);
      await expect(
        readFile(join(dir, 'legacy.geniro.yaml.bak'), 'utf8'),
      ).rejects.toThrow();
    });

    it('importFrom rejects a legacy external file and adds nothing to the library', async () => {
      const external = join(dir, '..', `legacy-ext-${Date.now()}.geniro.yaml`);
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
