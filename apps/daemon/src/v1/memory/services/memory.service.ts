import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';

import { NodeStateDao } from '../../agents/dao/node-state.dao';
import { RunDao } from '../../agents/dao/run.dao';
import { chatTextMatchQuery } from '../../agents/utils/chat-text-query';
import { hasHiddenText } from '../../agents/utils/hidden-text';
import { redactSecrets } from '../../diagnostics/utils/redact';
import { ProjectDao } from '../../projects/dao/project.dao';
import { ProjectRootsService } from '../../projects/services/project-roots.service';
import { TaskDao } from '../../tasks/dao/task.dao';
import { MemoryDao } from '../dao/memory.dao';
import { Memory } from '../entity/memory.entity';
import {
  DEFAULT_MEMORY_CONFIG,
  MEMORY_BODY_MAX_BYTES,
  MEMORY_FORGET_REASON_MAX_CHARS,
  MEMORY_READ_MAX,
  MEMORY_SEARCH_MAX,
  MEMORY_TITLE_MAX_CHARS,
  type MemoryActor,
  type MemoryChangedEvent,
  type MemoryConfig,
  type MemoryEntry,
  type MemoryForgetOutcome,
  memoryHandle,
  type MemoryHit,
  type MemoryRefusalCode,
  type MemorySaveInput,
  type MemorySaveOutcome,
  type MemoryStatus,
  type MemoryStatusOutcome,
  parseMemoryHandle,
} from '../memory.types';
import {
  excerptOf,
  similarTitles,
  titleCandidatesQuery,
} from '../utils/memory-text';
import { MemoryEventBus } from './memory-events.bus';

/** Near-duplicate candidates read per write before the title comparison. */
const DUPLICATE_CANDIDATES = 20;

type Refusal = Extract<MemorySaveOutcome, { kind: 'refused' }>;

/**
 * The memory every agent shares, on every CLI. Every write — an agent's tool
 * call, and later the user's edit, an import or an analysis — goes through
 * {@link save} / {@link forget}, which hold the limits: size, secrets,
 * near-duplicates, stale revisions and the review policy for agent writes.
 *
 * Writes are serialized, so a handle is allocated and a duplicate checked
 * against a table no other write is changing.
 */
@Injectable()
export class MemoryService {
  private config: MemoryConfig = DEFAULT_MEMORY_CONFIG;
  private writes: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly em: EntityManager,
    private readonly memories: MemoryDao,
    private readonly runs: RunDao,
    private readonly nodeStates: NodeStateDao,
    private readonly tasks: TaskDao,
    private readonly projects: ProjectDao,
    private readonly roots: ProjectRootsService,
    private readonly events: MemoryEventBus,
  ) {}

  get enabled(): boolean {
    return this.config.enabled;
  }

  setConfig(config: MemoryConfig): MemoryConfig {
    this.config = { ...config };
    return this.config;
  }

  /**
   * The project a run's memory is filed under: its task card's project, else
   * the live project whose folder the run works in (a task worktree resolves
   * to its repository), else none — global memory only.
   */
  async scopeOf(runId: string): Promise<string | null> {
    const em = this.em.fork();
    const run = await this.runs.getById(runId, em);
    if (!run) {
      return null;
    }
    if (run.taskId !== null) {
      const task = await this.tasks.getById(run.taskId, em);
      if (task && (await this.projects.getById(task.projectId, em))) {
        return task.projectId;
      }
    }
    if (run.cwd === null) {
      return null;
    }
    const root = (await this.roots.rootsOf([run.cwd])).get(run.cwd) ?? run.cwd;
    const project = await this.projects.findAnyByFolder(root, em);
    return project?.id ?? null;
  }

  /**
   * Who a tool call on this run and node is: the node's own agent in a
   * workflow, else the chat's. An analysis chat writes as `analysis`, held to
   * the same review rule as any agent.
   */
  async actorOf(runId: string, nodeId: string): Promise<MemoryActor> {
    const em = this.em.fork();
    const run = await this.runs.getById(runId, em);
    const node = await this.nodeStates.getByRunNode(runId, nodeId, em);
    const kind =
      run?.analysisSourceRunId || run?.analysisWorkflowSlug
        ? 'analysis'
        : 'agent';
    return {
      kind,
      runId,
      agentKind: node?.agentKind ?? run?.agentKind ?? null,
      model: node?.model ?? run?.model ?? null,
    };
  }

  /** The best active entries a run in `projectId` may see, best first. */
  async search(
    query: string,
    projectId: string | null,
    limit: number,
  ): Promise<MemoryHit[]> {
    const match = chatTextMatchQuery(query);
    if (match === null) {
      return [];
    }
    const em = this.em.fork();
    const ids = await this.memories.matchIds(
      match,
      { statuses: ['active'], projects: { visibleTo: projectId } },
      Math.min(Math.max(limit, 1), MEMORY_SEARCH_MAX),
      em,
    );
    const rows = new Map(
      (await this.memories.getByIds(ids, em)).map((row) => [row.id, row]),
    );
    return ids
      .map((id) => rows.get(id))
      .filter((row): row is Memory => row !== undefined)
      .map(toHit);
  }

  /**
   * Whole entries by handle, each one only if it is active and visible to
   * `projectId`; the rest come back as `missing`. Reading stamps `lastUsedAt`.
   */
  async read(
    handles: readonly string[],
    projectId: string | null,
  ): Promise<{ entries: MemoryEntry[]; missing: string[] }> {
    const wanted = handles.slice(0, MEMORY_READ_MAX);
    const numbers = wanted
      .map(parseMemoryHandle)
      .filter((n): n is number => n !== null);
    const byHandle = new Map(
      (
        await this.memories.getInScope(
          { statuses: ['active'], projects: { visibleTo: projectId } },
          numbers,
          this.em.fork(),
        )
      ).map((row) => [row.handle, row]),
    );
    const entries: MemoryEntry[] = [];
    const missing: string[] = [];
    for (const handle of wanted) {
      const number = parseMemoryHandle(handle);
      const row = number === null ? undefined : byHandle.get(number);
      if (row) {
        entries.push(toEntry(row));
      } else {
        missing.push(handle);
      }
    }
    await this.memories.touch(
      entries.map((entry) => entry.id),
      new Date(),
    );
    return { entries, missing };
  }

  /**
   * Create an entry, or update one in place when `input.handle` names it.
   * While the user reviews agent writes, an agent's new entry lands `pending`
   * and its update of an existing one is refused, so reviewed text is never
   * replaced unseen. `projectId` is the writer's own scope: an agent sees and
   * writes global entries plus its run's project.
   */
  save(
    actor: MemoryActor,
    input: MemorySaveInput,
    projectId: string | null,
  ): Promise<MemorySaveOutcome> {
    return this.serialize(() => this.saveNow(actor, input, projectId));
  }

  /**
   * Hide an entry from every agent, keeping it restorable. Refused to an agent
   * while the user reviews agent writes, like an update.
   */
  forget(
    actor: MemoryActor,
    handle: string,
    reason: string,
    projectId: string | null,
  ): Promise<MemoryForgetOutcome> {
    return this.serialize(() =>
      this.forgetNow(actor, handle, reason, projectId),
    );
  }

  /**
   * The user's own status change — approve a pending entry, restore a
   * forgotten one, or forget one — on any entry, whatever its scope. Refused to
   * an agent: approving is the review itself.
   */
  setStatus(
    actor: MemoryActor,
    id: string,
    status: MemoryStatus,
  ): Promise<MemoryStatusOutcome> {
    return this.serialize(async () => {
      if (isAgent(actor)) {
        return refused('USER_ONLY', 'only the user changes an entry’s status');
      }
      const em = this.em.fork();
      const row = await this.memories.getById(id, em);
      if (!row) {
        return refused('NOT_FOUND', `no memory ${id}`);
      }
      if (row.status !== status) {
        row.status = status;
        row.forgetReason = status === 'forgotten' ? row.forgetReason : null;
        row.rev += 1;
        await em.flush();
        this.publish(row, 'status');
      }
      return { kind: 'changed', entry: toEntry(row) };
    });
  }

  /**
   * Every active entry a run in `projectId` may see, its project's first, each
   * group most recently used first — what a run's memory index is cut from.
   */
  async listVisible(projectId: string | null): Promise<MemoryEntry[]> {
    const rows = await this.memories.getInScope(
      { statuses: ['active'], projects: { visibleTo: projectId } },
      undefined,
      this.em.fork(),
    );
    return rows
      .sort(
        (a, b) =>
          projectRank(a, projectId) - projectRank(b, projectId) ||
          usedAt(b) - usedAt(a),
      )
      .map(toEntry);
  }

  private async saveNow(
    actor: MemoryActor,
    input: MemorySaveInput,
    projectId: string | null,
  ): Promise<MemorySaveOutcome> {
    const invalid = this.refuseInvalid(actor, input);
    if (invalid) {
      return invalid;
    }
    if (input.handle !== undefined && this.underReview(actor)) {
      return refused(
        'UNDER_REVIEW',
        'the user reviews agent writes, so agents can only add new entries — save yours as a new entry, or tell the user what should change',
      );
    }
    const em = this.em.fork();
    const existing =
      input.handle === undefined
        ? null
        : await this.findVisible(input.handle, projectId, em);
    if (input.handle !== undefined && !existing) {
      return refused(
        'NOT_FOUND',
        `no active memory ${input.handle} this run can see — search again`,
      );
    }
    if (existing && input.rev !== existing.rev) {
      return { kind: 'stale', current: toEntry(existing) };
    }
    const target = targetProject(input, existing, projectId);
    if (target === undefined) {
      return refused(
        'NO_PROJECT',
        'this run works in no project, so the entry can only be global — save it with scope: global',
      );
    }
    const duplicates = await this.nearDuplicates(input, target, existing, em);
    const live = duplicates.filter((row) => row.status === 'active');
    // The user is the reviewer: an entry waiting on them never blocks them.
    const pending = isAgent(actor)
      ? duplicates.filter((row) => row.status === 'pending')
      : [];
    if (live.length > 0 || pending.length > 0) {
      return {
        kind: 'near_duplicate',
        candidates: live.map(toHit),
        pending: pending.map((row) => memoryHandle(row.handle)),
        updatable: !this.underReview(actor),
      };
    }
    const status = this.underReview(actor) ? 'pending' : 'active';
    const row = existing ?? new Memory();
    if (existing) {
      row.rev += 1;
    } else {
      row.handle = await this.memories.nextHandle(em);
    }
    row.title = input.title.trim();
    row.body = input.body.trim();
    row.type = input.type ?? existing?.type ?? 'project';
    row.projectId = target;
    row.status = status;
    stampSource(row, actor);
    em.persist(row);
    await em.flush();
    this.publish(row, existing ? 'updated' : 'created');
    return { kind: existing ? 'updated' : 'created', entry: toEntry(row) };
  }

  private async forgetNow(
    actor: MemoryActor,
    handle: string,
    reason: string,
    projectId: string | null,
  ): Promise<MemoryForgetOutcome> {
    if (isAgent(actor) && !this.config.enabled) {
      return refused('MEMORY_DISABLED', 'the user has turned memory off');
    }
    if (this.underReview(actor)) {
      return refused(
        'UNDER_REVIEW',
        'the user reviews agent writes, so agents cannot forget entries — tell the user which entry is wrong and why',
      );
    }
    const trimmed = reason.trim();
    if (
      trimmed.length === 0 ||
      trimmed.length > MEMORY_FORGET_REASON_MAX_CHARS ||
      hasHiddenText(trimmed, false)
    ) {
      return refused(
        'INVALID_ENTRY',
        `the reason must be one line of 1–${MEMORY_FORGET_REASON_MAX_CHARS} characters`,
      );
    }
    if (redactSecrets(trimmed) !== trimmed) {
      return refused(
        'CONTAINS_SECRET',
        'the reason contains a secret geniro knows about; write it without one',
      );
    }
    const em = this.em.fork();
    const row = await this.findVisible(handle, projectId, em);
    if (!row) {
      return refused(
        'NOT_FOUND',
        `no active memory ${handle} this run can see`,
      );
    }
    row.status = 'forgotten';
    row.forgetReason = trimmed;
    row.rev += 1;
    await em.flush();
    this.publish(row, 'status');
    return { kind: 'forgotten', entry: toEntry(row) };
  }

  private refuseInvalid(
    actor: MemoryActor,
    input: MemorySaveInput,
  ): Refusal | null {
    if (isAgent(actor) && !this.config.enabled) {
      return refused('MEMORY_DISABLED', 'the user has turned memory off');
    }
    const title = input.title.trim();
    const body = input.body.trim();
    if (
      title.length === 0 ||
      [...title].length > MEMORY_TITLE_MAX_CHARS ||
      hasHiddenText(title, false)
    ) {
      return refused(
        'INVALID_ENTRY',
        `the title must be one line of 1–${MEMORY_TITLE_MAX_CHARS} characters`,
      );
    }
    if (body.length === 0 || hasHiddenText(body, true)) {
      return refused(
        'INVALID_ENTRY',
        'the body must be non-empty text without control or invisible characters',
      );
    }
    const bytes = Buffer.byteLength(body, 'utf8');
    if (bytes > MEMORY_BODY_MAX_BYTES) {
      return refused(
        'INVALID_ENTRY',
        `the body is ${bytes} bytes; the limit is ${MEMORY_BODY_MAX_BYTES} — keep one fact per entry`,
      );
    }
    if (redactSecrets(title) !== title || redactSecrets(body) !== body) {
      return refused(
        'CONTAINS_SECRET',
        'the entry contains a secret geniro knows about; never store credentials in memory',
      );
    }
    return null;
  }

  /** Whether this writer's changes wait for the user's review. */
  private underReview(actor: MemoryActor): boolean {
    return isAgent(actor) && this.config.agentWrites === 'pending';
  }

  private publish(row: Memory, change: MemoryChangedEvent['change']): void {
    this.events.publish({
      memoryId: row.id,
      change,
      status: row.status,
      projectId: row.projectId,
    });
  }

  private async findVisible(
    handle: string,
    projectId: string | null,
    em: EntityManager,
  ): Promise<Memory | null> {
    const number = parseMemoryHandle(handle);
    if (number === null) {
      return null;
    }
    const [row] = await this.memories.getInScope(
      { statuses: ['active'], projects: { visibleTo: projectId } },
      [number],
      em,
    );
    return row ?? null;
  }

  /**
   * Live entries in the target scope whose title says the same thing, minus
   * the entry being updated and the ones the writer vouched for.
   */
  private async nearDuplicates(
    input: MemorySaveInput,
    target: string | null,
    existing: Memory | null,
    em: EntityManager,
  ): Promise<Memory[]> {
    const query = titleCandidatesQuery(input.title);
    if (query === null) {
      return [];
    }
    const vouched = new Set(
      (input.notDuplicateOf ?? [])
        .map(parseMemoryHandle)
        .filter((n): n is number => n !== null),
    );
    const ids = await this.memories.matchIds(
      query,
      { statuses: ['active', 'pending'], projects: { exactly: target } },
      DUPLICATE_CANDIDATES,
      em,
    );
    return (await this.memories.getByIds(ids, em)).filter(
      (row) =>
        row.id !== existing?.id &&
        !vouched.has(row.handle) &&
        similarTitles(row.title, input.title),
    );
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this.writes.then(work, work);
    this.writes = next.catch(() => undefined);
    return next;
  }
}

function isAgent(actor: MemoryActor): boolean {
  return actor.kind === 'agent' || actor.kind === 'analysis';
}

function projectRank(row: Memory, projectId: string | null): number {
  return projectId !== null && row.projectId === projectId ? 0 : 1;
}

function usedAt(row: Memory): number {
  return (row.lastUsedAt ?? row.updatedAt).getTime();
}

function refused(code: MemoryRefusalCode, reason: string): Refusal {
  return { kind: 'refused', code, reason };
}

/**
 * Where the entry is filed: the scope asked for, else where it already is,
 * else the writer's project when it has one. Undefined when a project scope
 * was asked for by a writer with no project.
 */
function targetProject(
  input: MemorySaveInput,
  existing: Memory | null,
  projectId: string | null,
): string | null | undefined {
  if (input.scope === 'global') {
    return null;
  }
  if (input.scope === 'project') {
    return projectId ?? undefined;
  }
  return existing ? existing.projectId : projectId;
}

function stampSource(row: Memory, actor: MemoryActor): void {
  row.sourceActor = actor.kind;
  row.sourceAgentKind = 'agentKind' in actor ? actor.agentKind : null;
  row.sourceModel = 'model' in actor ? actor.model : null;
  row.sourceRunId = 'runId' in actor ? actor.runId : null;
  row.sourceImportedFrom = actor.kind === 'import' ? actor.importedFrom : null;
}

function toEntry(row: Memory): MemoryEntry {
  return {
    id: row.id,
    handle: memoryHandle(row.handle),
    title: row.title,
    body: row.body,
    type: row.type,
    projectId: row.projectId,
    status: row.status,
    rev: row.rev,
    source: {
      actor: row.sourceActor,
      agentKind: row.sourceAgentKind,
      model: row.sourceModel,
      runId: row.sourceRunId,
      importedFrom: row.sourceImportedFrom,
    },
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
  };
}

/**
 * The excerpt is masked BEFORE it is cut: a secret registered after the entry
 * was saved could otherwise straddle the cut and leave as an unmasked prefix.
 */
function toHit(row: Memory): MemoryHit {
  const { body, ...rest } = toEntry(row);
  return { ...rest, excerpt: excerptOf(redactSecrets(body)) };
}
