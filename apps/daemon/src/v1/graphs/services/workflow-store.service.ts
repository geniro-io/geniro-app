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
  parseLegacyWorkflowYaml,
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
        const workflow = await this.loadWorkflow(
          path,
          await readFile(path, 'utf8'),
        );
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
    return { slug, workflow: await this.loadWorkflow(path, source) };
  }

  /**
   * Strict-parse one library file's already-read source. A file the strict
   * schema rejects gets ONE lenient retry as a legacy (pre-kind) file: on
   * success the original bytes are backed up to `<file>.bak` (never
   * clobbering an earlier backup) and the file is rewritten with kinds
   * explicit — after that it strict-parses forever, so the normalization is
   * one-time by construction. The backup exists because these files live
   * outside git: without it, a code revert would silently downgrade call
   * edges to data edges.
   */
  private async loadWorkflow(path: string, source: string): Promise<Workflow> {
    try {
      return parseWorkflowYaml(source);
    } catch (err) {
      const legacy = parseLegacyWorkflowYaml(source);
      if (!legacy) {
        throw err;
      }
      const backup = `${path}.bak`;
      if (!(await this.exists(backup))) {
        await writeFile(backup, source, 'utf8');
      }
      const normalized = serializeWorkflowYaml(legacy, source);
      await this.atomicWrite(path, normalized);
      this.logger.warn(
        `normalized legacy workflow ${basename(path)} (original backed up to ${basename(backup)})`,
      );
      // Return what was PERSISTED, not the lenient parse: the serializer's
      // per-(from,to,kind) edge map can legally collapse a legacy duplicate,
      // and the first read must agree with every later one.
      return parseWorkflowYaml(normalized);
    }
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
    const base = slug ?? this.slugify(workflow.name);
    let candidate = base;
    for (let attempt = 2; ; attempt++) {
      try {
        await this.atomicCreate(this.fileFor(candidate), content);
        return { slug: candidate, workflow };
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'EEXIST') {
          throw err;
        }
        if (slug) {
          throw new ConflictException(
            'WORKFLOW_EXISTS',
            `Workflow '${slug}' already exists`,
          );
        }
        candidate = `${base}-${attempt}`;
      }
    }
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
    // The backup belongs to the deleted file: left behind, it would block
    // the one-time .bak of a FUTURE legacy file landing on the same slug.
    await rm(`${path}.bak`, { force: true });
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
    let workflow: Workflow;
    let content = source;
    try {
      workflow = parseWorkflowYaml(source);
    } catch (err) {
      // Legacy (pre-kind) external file: import it normalized — the library
      // only ever holds strict-parseable files. The user's original stays
      // untouched at sourcePath, so no backup is needed here.
      const legacy = parseLegacyWorkflowYaml(source);
      if (!legacy) {
        throw err;
      }
      workflow = legacy;
      content = serializeWorkflowYaml(legacy, source);
    }
    this.validateGraph(workflow);
    await mkdir(this.dir, { recursive: true });
    const importedName = basename(sourcePath).endsWith(WORKFLOW_SUFFIX)
      ? basename(sourcePath).slice(0, -WORKFLOW_SUFFIX.length)
      : workflow.name;
    const slug = await this.uniqueSlug(importedName);
    // Strict files land verbatim — the user's comments come along.
    await this.atomicWrite(this.fileFor(slug), content);
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
    await writeFile(tmp, content, 'utf8');
    await rename(tmp, path);
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

  private slugify(name: string): string {
    return (
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 64) || 'workflow'
    );
  }

  private async uniqueSlug(name: string): Promise<string> {
    const base = this.slugify(name);
    let candidate = base;
    let n = 2;
    while (
      await this.exists(join(this.dir, `${candidate}${WORKFLOW_SUFFIX}`))
    ) {
      candidate = `${base}-${n++}`;
    }
    return candidate;
  }
}
