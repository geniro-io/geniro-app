import {
  link,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { basename, join } from 'node:path';

import { Injectable, Logger } from '@nestjs/common';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@packages/common';

import { environment } from '../../../environments';
import type { AgentKind } from '../../runs/runs.types';
import {
  type Workflow,
  WORKFLOW_AGENT_KINDS,
  type WorkflowSummary,
  type WorkflowWire,
} from '../graphs.types';
import { computeRunOrder } from '../utils/graph-order';
import { validateWorkflowGraph } from '../utils/graph-validate';
import {
  parseWorkflowYaml,
  serializeWorkflowYaml,
} from '../utils/workflow-yaml';

/** Library file suffix — a workflow `foo` lives at `<dir>/foo.geniro.yaml`. */
const WORKFLOW_SUFFIX = '.geniro.yaml';

/** Slug charset — a plain file-name segment, so no path traversal is possible. */
const SLUG_RE = /^[a-z0-9][a-z0-9-_]*$/i;

/**
 * Tally a workflow's nodes by agent kind for the library summary. Only kinds
 * actually present appear, ordered by `WORKFLOW_AGENT_KINDS` so the card badges
 * render in a stable order regardless of node declaration order.
 */
function agentCountsOf(
  workflow: Workflow,
): { kind: AgentKind; count: number }[] {
  const counts = new Map<AgentKind, number>();
  for (const node of workflow.nodes) {
    if (node.kind === 'agent') {
      counts.set(node.agent, (counts.get(node.agent) ?? 0) + 1);
    }
  }
  return WORKFLOW_AGENT_KINDS.flatMap((kind) => {
    const count = counts.get(kind);
    return count ? [{ kind, count }] : [];
  });
}

export interface WorkflowStoreOptions {
  /** Library directory override (test seam); default `<userData>/workflows`. */
  workflowsDir?: string;
}

/**
 * The central workflow library: `*.geniro.yaml` files under the userData dir.
 * YAML is the source of truth (never SQLite); saves go through the
 * comment-preserving serializer and are validated (zod shape + graph
 * structure + acyclicity) before touching disk. Writes are atomic
 * (tmp + rename) so a crash never leaves a half-written workflow.
 */
@Injectable()
export class WorkflowStoreService {
  private readonly logger = new Logger(WorkflowStoreService.name);
  private readonly dir: string;

  constructor(options: WorkflowStoreOptions = {}) {
    this.dir =
      options.workflowsDir ?? join(environment.userDataDir, 'workflows');
  }

  private fileFor(slug: string): string {
    if (!SLUG_RE.test(slug)) {
      throw new BadRequestException(
        'WORKFLOW_SLUG_INVALID',
        `Workflow slug must match ${SLUG_RE}: ${slug}`,
      );
    }
    return join(this.dir, `${slug}${WORKFLOW_SUFFIX}`);
  }

  /** Validate beyond the zod shape: ids unique, edges resolvable, acyclic. */
  private validateGraph(workflow: Workflow): void {
    validateWorkflowGraph(workflow.nodes, workflow.edges);
    computeRunOrder(workflow.nodes, workflow.edges);
  }

  async list(): Promise<WorkflowSummary[]> {
    await mkdir(this.dir, { recursive: true });
    const entries = await readdir(this.dir);
    const summaries: WorkflowSummary[] = [];
    for (const entry of entries.filter((e) => e.endsWith(WORKFLOW_SUFFIX))) {
      const path = join(this.dir, entry);
      try {
        const workflow = parseWorkflowYaml(await readFile(path, 'utf8'));
        const stats = await stat(path);
        summaries.push({
          slug: entry.slice(0, -WORKFLOW_SUFFIX.length),
          name: workflow.name,
          description: workflow.description ?? null,
          nodeCount: workflow.nodes.length,
          edgeCount: workflow.edges.length,
          agentCounts: agentCountsOf(workflow),
          updatedAt: stats.mtime.toISOString(),
        });
      } catch (err) {
        // A corrupt file must not hide the rest of the library; it stays on
        // disk for the user to repair and is only skipped from the listing.
        this.logger.warn(
          `skipping unreadable workflow ${entry}: ${String(err)}`,
        );
      }
    }
    // Newest-updated first (ISO strings compare chronologically); slug breaks
    // ties so same-mtime files keep a stable order between listings.
    return summaries.sort(
      (a, b) =>
        b.updatedAt.localeCompare(a.updatedAt) || a.slug.localeCompare(b.slug),
    );
  }

  async get(slug: string): Promise<WorkflowWire> {
    const path = this.fileFor(slug);
    // One read serves both the 404 mapping and the parse — a second read
    // could race a concurrent delete into a raw ENOENT instead of the 404.
    const source = await this.readSource(path, slug);
    return { slug, workflow: parseWorkflowYaml(source) };
  }

  /**
   * Create a new workflow; slug derived from the name when not supplied.
   * The file lands via an exclusive atomic commit ({@link atomicCreate}), so
   * concurrent creates can never share or clobber one file and a crash never
   * leaves a half-written library entry: an explicit-slug collision surfaces
   * as WORKFLOW_EXISTS, a derived-slug collision retries the next suffix.
   */
  async create(workflow: Workflow, slug?: string): Promise<WorkflowWire> {
    this.validateGraph(workflow);
    await mkdir(this.dir, { recursive: true });
    const content = serializeWorkflowYaml(workflow);
    if (slug) {
      try {
        await this.atomicCreate(this.fileFor(slug), content);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
          throw new ConflictException(
            'WORKFLOW_EXISTS',
            `Workflow '${slug}' already exists`,
          );
        }
        throw err;
      }
      return { slug, workflow };
    }
    const landed = await this.createDerivedSlug(
      this.slugify(workflow.name),
      content,
    );
    return { slug: landed, workflow };
  }

  /** Save (upsert) a workflow, preserving hand-written YAML comments. */
  async save(slug: string, workflow: Workflow): Promise<WorkflowWire> {
    this.validateGraph(workflow);
    await mkdir(this.dir, { recursive: true });
    const path = this.fileFor(slug);
    const existing = (await this.exists(path))
      ? await readFile(path, 'utf8')
      : null;
    await this.atomicWrite(path, serializeWorkflowYaml(workflow, existing));
    return { slug, workflow };
  }

  async delete(slug: string): Promise<void> {
    const path = this.fileFor(slug);
    if (!(await this.exists(path))) {
      throw new NotFoundException(
        'WORKFLOW_NOT_FOUND',
        `No workflow '${slug}' in the library`,
      );
    }
    await rm(path);
  }

  /** Copy an external `*.geniro.yaml` into the library (validated first). */
  async importFrom(sourcePath: string): Promise<WorkflowWire> {
    let source: string;
    try {
      source = await readFile(sourcePath, 'utf8');
    } catch {
      throw new BadRequestException(
        'WORKFLOW_IMPORT_UNREADABLE',
        `Cannot read ${sourcePath}`,
      );
    }
    // A kind-less legacy (pre-kind) file is refused, not normalized
    // (no-backcompat): parseWorkflowYaml throws WORKFLOW_YAML_INVALID, which
    // the controller maps to 400. The library only ever holds strict files.
    const workflow = parseWorkflowYaml(source);
    this.validateGraph(workflow);
    await mkdir(this.dir, { recursive: true });
    const importedName = basename(sourcePath).endsWith(WORKFLOW_SUFFIX)
      ? basename(sourcePath).slice(0, -WORKFLOW_SUFFIX.length)
      : workflow.name;
    // Strict files land verbatim — the user's comments come along. The slug
    // commits through the same exclusive loop as create(): a stat-then-write
    // here was a TOCTOU that let a racing writer on the same slug be clobbered.
    const slug = await this.createDerivedSlug(
      this.slugify(importedName),
      source,
    );
    return { slug, workflow };
  }

  /** Export a library workflow to an external path chosen by the user. */
  async exportTo(slug: string, targetPath: string): Promise<void> {
    if (!/\.ya?ml$/i.test(targetPath)) {
      throw new BadRequestException(
        'WORKFLOW_EXPORT_FAILED',
        'Export target must be a .yaml file',
      );
    }
    const path = this.fileFor(slug);
    const source = await this.readSource(path, slug);
    try {
      await writeFile(targetPath, source, 'utf8');
    } catch {
      throw new BadRequestException(
        'WORKFLOW_EXPORT_FAILED',
        `Cannot write ${targetPath}`,
      );
    }
  }

  private async readSource(path: string, slug: string): Promise<string> {
    try {
      return await readFile(path, 'utf8');
    } catch {
      throw new NotFoundException(
        'WORKFLOW_NOT_FOUND',
        `No workflow '${slug}' in the library`,
      );
    }
  }

  private async exists(path: string): Promise<boolean> {
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  }

  private async atomicWrite(path: string, content: string): Promise<void> {
    // Unique staging name: two concurrent writers sharing `${path}.tmp` would
    // interleave content and race the rename.
    const tmp = `${path}.${process.pid}.${WorkflowStoreService.tmpSeq++}.tmp`;
    // writeFile inside the try so a failed stage (disk full, EACCES) still
    // cleans up any partial tmp — the unique name means nothing else ever
    // reclaims a stray. After a successful rename the unlink is an ENOENT
    // no-op.
    try {
      await writeFile(tmp, content, 'utf8');
      await rename(tmp, path);
    } finally {
      await unlink(tmp).catch(() => {});
    }
  }

  /**
   * Exclusive sibling of {@link atomicWrite}: stage to a unique tmp file, then
   * hard-link it to the final path. `link` fails with EEXIST when the slug is
   * taken (the `wx` exclusivity a plain rename would lose) and never exposes a
   * half-written file (the atomicity a direct `wx` write lacked).
   */
  private async atomicCreate(path: string, content: string): Promise<void> {
    const tmp = `${path}.${process.pid}.${WorkflowStoreService.tmpSeq++}.tmp`;
    // writeFile inside the try so a failed stage (disk full, EACCES) still
    // cleans up any partial tmp — the finally must guard the write too.
    try {
      await writeFile(tmp, content, 'utf8');
      await link(tmp, path);
    } finally {
      await unlink(tmp).catch(() => {});
    }
  }

  private static tmpSeq = 0;

  /**
   * Land `content` at the first free suffixed candidate of `base` through the
   * exclusive {@link atomicCreate} commit — the one slug-allocation path shared
   * by create() and importFrom(), so no sibling reintroduces the
   * check-then-rename TOCTOU a stat loop + rename-over had.
   */
  private async createDerivedSlug(
    base: string,
    content: string,
  ): Promise<string> {
    let candidate = base;
    for (let attempt = 2; ; attempt++) {
      try {
        await this.atomicCreate(this.fileFor(candidate), content);
        return candidate;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw err;
        }
        candidate = `${base}-${attempt}`;
      }
    }
  }

  private slugify(name: string): string {
    return (
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 64) || 'workflow'
    );
  }
}
