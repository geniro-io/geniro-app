import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable, Logger } from '@nestjs/common';

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
  MEMORY_LIST_LIMIT_DEFAULT,
  MEMORY_READ_MAX,
  MEMORY_SEARCH_MAX,
  MEMORY_STATUSES,
  MEMORY_TITLE_MAX_CHARS,
  type MemoryActor,
  type MemoryChange,
  type MemoryConfig,
  type MemoryCreateInput,
  type MemoryEdit,
  type MemoryEntry,
  type MemoryExport,
  type MemoryForgetAll,
  type MemoryForgetOutcome,
  memoryHandle,
  type MemoryHit,
  type MemoryImportNote,
  type MemoryImportResult,
  type MemoryList,
  type MemoryListQuery,
  type MemoryPatch,
  type MemoryRefusalCode,
  type MemoryRunSnapshot,
  type MemorySaveInput,
  type MemorySaveOutcome,
  type MemoryScopeFacts,
  type MemoryStatusOutcome,
  type MemoryUserStatus,
  parseMemoryHandle,
} from '../memory.types';
import { memoryExportMarkdown } from '../utils/memory-export';
import {
  excerptOf,
  importedText,
  memoryIndexText,
  similarTitles,
  titleCandidatesQuery,
} from '../utils/memory-text';
import { MemoryEventBus } from './memory-events.bus';

/** Near-duplicate candidates read per write before the title comparison. */
const DUPLICATE_CANDIDATES = 20;

type Refusal = Extract<MemorySaveOutcome, { kind: 'refused' }>;

/** What a write stores, whoever writes it. */
type MemoryText = Pick<
  MemorySaveInput,
  'title' | 'body' | 'type' | 'notDuplicateOf'
>;

const USER: MemoryActor = { kind: 'user' };

/** The writer the import preview checks a note as: never an agent. */
const IMPORT_CHECK: MemoryActor = { kind: 'import', importedFrom: '' };

/**
 * The memory every agent shares, on every CLI. Every write is made here — an
 * agent's {@link save} / {@link forget}, the user's {@link create},
 * {@link edit}, {@link setStatus} and {@link forgetAll}, and
 * {@link importNotes} — and each holds the limits: size, secrets,
 * near-duplicates, stale revisions and the review policy for agent writes.
 *
 * Writes are serialized, so a handle is allocated and a duplicate checked
 * against a table no other write is changing.
 */
@Injectable()
export class MemoryService {
  private readonly logger = new Logger(MemoryService.name);
  private config: MemoryConfig = DEFAULT_MEMORY_CONFIG;
  private configured = false;
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
    this.configured = true;
    return this.config;
  }

  /**
   * The project a run's memory is filed under: its task card's project, else
   * the live project whose folder the run works in (a task worktree resolves
   * to its repository), else none — global memory only.
   */
  async scopeOf(runId: string): Promise<string | null> {
    const run = await this.runs.getById(runId, this.em.fork());
    return run ? this.scopeFor(run) : null;
  }

  /** {@link scopeOf} for a run whose row does not exist yet. */
  async scopeFor({ taskId, cwd }: MemoryScopeFacts): Promise<string | null> {
    const em = this.em.fork();
    if (taskId !== null) {
      const task = await this.tasks.getById(taskId, em);
      if (task && (await this.projects.getById(task.projectId, em))) {
        return task.projectId;
      }
    }
    if (cwd === null) {
      return null;
    }
    const root = (await this.roots.rootsOf([cwd])).get(cwd) ?? cwd;
    const project = await this.projects.findAnyByFolder(root, em);
    return project?.id ?? null;
  }

  /**
   * What a new run keeps of the shared memory for its whole life. Taken once,
   * at creation: both fields reach `AgentAdapter.sessionKey`, so a live read
   * would respawn a kept CLI whenever any agent saved a note or the user
   * flipped the switch. A failed read costs the run its index, never its start.
   *
   * Until Electron's first push the daemon holds only the default, which may
   * not be the user's: a run kept for its whole life is created without
   * memory rather than with a setting nobody chose. Each CLI's own memory is
   * off only while the shared memory is on and the user switched it off (a
   * successful import does), so an agent keeps one memory without the CLIs'
   * notes being hidden before they are brought over.
   */
  async runSnapshot(facts: MemoryScopeFacts): Promise<MemoryRunSnapshot> {
    const none: MemoryRunSnapshot = {
      nativeMemoryOff: false,
      memoryIndex: null,
    };
    if (!this.configured || !this.enabled) {
      return none;
    }
    const shared = { ...none, nativeMemoryOff: this.config.nativeMemoryOff };
    try {
      const entries = await this.listVisible(await this.scopeFor(facts));
      return {
        ...shared,
        memoryIndex: memoryIndexText(entries.filter(indexable), new Date()),
      };
    } catch (error) {
      this.logger.warn(
        `memory index not read: ${error instanceof Error ? error.message : String(error)}`,
      );
      return shared;
    }
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
   * The user's own status change — approve an entry, restore a forgotten one
   * to the status it had, or forget one — on any entry, whatever its scope.
   * Refused to an agent: approving is the review itself.
   */
  setStatus(
    actor: MemoryActor,
    id: string,
    status: MemoryUserStatus,
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
      const change = applyStatus(row, status, new Date());
      if (change !== null) {
        row.rev += 1;
        await em.flush();
        this.publish(row, change);
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

  /** One page of the user's list, newest edit first. */
  async list(query: MemoryListQuery): Promise<MemoryList> {
    const limit = query.limit ?? MEMORY_LIST_LIMIT_DEFAULT;
    let match: string | undefined;
    if (query.q !== undefined) {
      const ready = chatTextMatchQuery(query.q);
      if (ready === null) {
        return { memories: [], next: null };
      }
      match = ready;
    }
    const rows = await this.memories.page(
      {
        statuses: query.status
          ? [query.status]
          : query.handle !== undefined
            ? MEMORY_STATUSES
            : ['active', 'pending'],
        handle:
          query.handle === undefined
            ? undefined
            : (parseMemoryHandle(query.handle) ?? undefined),
        projects:
          query.scope === 'global'
            ? { exactly: null }
            : query.scope === 'project' && query.projectId !== undefined
              ? { exactly: query.projectId }
              : { any: true },
        type: query.type,
        match,
        before:
          query.beforeUpdatedAt !== undefined && query.beforeId !== undefined
            ? { updatedAt: new Date(query.beforeUpdatedAt), id: query.beforeId }
            : undefined,
        limit,
      },
      this.em.fork(),
    );
    const last = rows.at(-1);
    return {
      memories: rows.map(toEntry),
      next:
        rows.length === limit && last
          ? {
              beforeUpdatedAt: last.updatedAt.toISOString(),
              beforeId: last.id,
            }
          : null,
    };
  }

  /** One entry by id, whatever its status or scope — the user's read. */
  async get(id: string): Promise<MemoryEntry | null> {
    const row = await this.memories.getById(id, this.em.fork());
    return row ? toEntry(row) : null;
  }

  /** The user's own new entry, filed where the user chose. */
  create(input: MemoryCreateInput): Promise<MemorySaveOutcome> {
    return this.serialize(async () => {
      const invalid = this.refuseInvalid(USER, input);
      if (invalid) {
        return invalid;
      }
      const em = this.em.fork();
      const unknown = await this.refuseUnknownProject(input.projectId, em);
      return unknown ?? this.writeRow(USER, input, input.projectId, null, em);
    });
  }

  /**
   * The user's edit of an entry's text, type or scope at the `rev` it was read
   * at. Editing a pending entry makes it the user's own, so it is no longer
   * waiting on review; a forgotten one must be restored before it is edited.
   */
  edit(id: string, input: MemoryEdit): Promise<MemorySaveOutcome> {
    return this.serialize(async () => {
      const invalid = this.refuseInvalid(USER, input);
      if (invalid) {
        return invalid;
      }
      const em = this.em.fork();
      const row = await this.memories.getById(id, em);
      if (!row || row.status === 'forgotten') {
        return refused(
          'NOT_FOUND',
          row ? 'restore the entry before editing it' : `no memory ${id}`,
        );
      }
      if (input.rev !== row.rev) {
        return { kind: 'stale', current: toEntry(row) };
      }
      const unknown = await this.refuseUnknownProject(input.projectId, em);
      return unknown ?? this.writeRow(USER, input, input.projectId, row, em);
    });
  }

  /** The user's PATCH: a status change, or an edit of text and scope. */
  change(
    id: string,
    patch: MemoryPatch,
  ): Promise<MemorySaveOutcome | MemoryStatusOutcome> {
    if (patch.status !== undefined) {
      return this.setStatus(USER, id, patch.status);
    }
    const { rev, title, body, type, projectId, notDuplicateOf } = patch;
    if (
      rev === undefined ||
      title === undefined ||
      body === undefined ||
      type === undefined ||
      projectId === undefined
    ) {
      return Promise.resolve(
        refused(
          'INVALID_ENTRY',
          'an edit carries rev, title, body, type and projectId',
        ),
      );
    }
    return this.edit(id, { rev, title, body, type, projectId, notDuplicateOf });
  }

  /** Forget every active and pending entry, each one restorable. */
  forgetAll(): Promise<MemoryForgetAll> {
    return this.serialize(async () => {
      const forgotten = await this.memories.forgetAll(
        new Date(),
        this.em.fork(),
      );
      if (forgotten > 0) {
        this.events.publish({
          memoryId: null,
          change: 'bulk',
          status: 'forgotten',
          projectId: null,
        });
      }
      return { forgotten };
    });
  }

  /** Every active and pending entry as one Markdown document. */
  async exportMarkdown(now = new Date()): Promise<MemoryExport> {
    const em = this.em.fork();
    const rows = await this.memories.getAll(
      { status: { $in: ['active', 'pending'] } },
      { orderBy: { updatedAt: 'desc' } },
      em,
    );
    const projects = new Map(
      (await this.projects.getAll({}, undefined, em)).map((project) => [
        project.id,
        project.name,
      ]),
    );
    return {
      markdown: memoryExportMarkdown(rows.map(toEntry), projects, now),
      count: rows.length,
    };
  }

  /** Why a note could not be stored as an entry, or null when it could. */
  problemOf(note: Pick<MemorySaveInput, 'title' | 'body'>): string | null {
    return this.refuseInvalid(IMPORT_CHECK, note)?.reason ?? null;
  }

  /** Active and pending entries filed in `projectId` whose title says the same. */
  async similarTo(title: string, projectId: string | null): Promise<Memory[]> {
    return this.nearDuplicates(
      { title, body: '' },
      projectId,
      null,
      this.em.fork(),
    );
  }

  /** What the active and pending imported entries say, each as `importedText`. */
  async importedTexts(
    em: EntityManager = this.em.fork(),
  ): Promise<Set<string>> {
    const rows = await this.memories.getAll(
      {
        sourceActor: 'import',
        status: { $in: ['active', 'pending'] },
      },
      { fields: ['title', 'body'] },
      em,
    );
    return new Set(rows.map((row) => importedText(row.title, row.body)));
  }

  /**
   * Write the notes the user ticked in the import preview. Ticking one is the
   * user's review: each lands active and approved, past the near-duplicate
   * check the preview already showed, in one write announced as one `bulk`
   * change. A note whose text an active or pending imported entry already
   * holds is skipped, so a retried or repeated import writes it once.
   */
  importNotes(notes: readonly MemoryImportNote[]): Promise<MemoryImportResult> {
    return this.serialize(async () => {
      const em = this.em.fork();
      const projects = new Set(
        (await this.projects.getAll({}, undefined, em)).map((p) => p.id),
      );
      const held = await this.importedTexts(em);
      const skipped: MemoryImportResult['skipped'] = [];
      const now = new Date();
      let handle = await this.memories.nextHandle(em);
      let imported = 0;
      for (const note of notes) {
        const actor: MemoryActor = {
          kind: 'import',
          importedFrom: note.importedFrom,
        };
        const refusal =
          this.refuseInvalid(actor, note) ??
          (note.projectId !== null && !projects.has(note.projectId)
            ? refused('NO_PROJECT', `no project ${note.projectId}`)
            : null);
        if (refusal) {
          skipped.push({ key: note.key, reason: refusal.reason });
          continue;
        }
        const text = importedText(note.title, note.body);
        if (held.has(text)) {
          skipped.push({ key: note.key, reason: 'already imported' });
          continue;
        }
        held.add(text);
        const row = new Memory();
        row.handle = handle++;
        row.title = note.title.trim();
        row.body = note.body.trim();
        row.type = note.type;
        row.projectId = note.projectId;
        row.status = 'active';
        stampSource(row, actor);
        row.approvedAt = now;
        em.persist(row);
        imported += 1;
      }
      if (imported > 0) {
        await em.flush();
        this.events.publish({
          memoryId: null,
          change: 'bulk',
          status: 'active',
          projectId: null,
        });
      }
      return { imported, skipped };
    });
  }

  private async refuseUnknownProject(
    projectId: string | null,
    em: EntityManager,
  ): Promise<Refusal | null> {
    if (projectId === null || (await this.projects.getById(projectId, em))) {
      return null;
    }
    return refused('NO_PROJECT', `no project ${projectId}`);
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
    return this.writeRow(actor, input, target, existing, em);
  }

  private async writeRow(
    actor: MemoryActor,
    input: MemoryText,
    target: string | null,
    existing: Memory | null,
    em: EntityManager,
  ): Promise<MemorySaveOutcome> {
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
    row.statusBeforeForget = row.status;
    row.status = 'forgotten';
    row.forgetReason = trimmed;
    row.rev += 1;
    await em.flush();
    this.publish(row, 'forgotten');
    return { kind: 'forgotten', entry: toEntry(row) };
  }

  private refuseInvalid(
    actor: MemoryActor,
    input: Pick<MemorySaveInput, 'title' | 'body'>,
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

  private publish(row: Memory, change: MemoryChange): void {
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
    input: MemoryText,
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

/**
 * Whether an entry may sit in a run's instructions: the user's own, an
 * import's, or one the user approved. An agent's unreviewed entry is reached
 * only through `memory_search`, a tool result framed as data — one an agent
 * was steered into saving must not speak in every later run's instructions.
 */
function indexable(entry: MemoryEntry): boolean {
  return (
    entry.source.actor === 'user' ||
    entry.source.actor === 'import' ||
    entry.approvedAt !== null
  );
}

/**
 * Move `row` to the user's chosen status and name what that did, or null when
 * it changes nothing. Forgetting keeps what the entry was, so a restore puts
 * it back there — a pending entry waits for review again — and approval stays
 * a press of its own.
 */
function applyStatus(
  row: Memory,
  status: MemoryUserStatus,
  now: Date,
): MemoryChange | null {
  if (status === 'forgotten') {
    if (row.status === 'forgotten') {
      return null;
    }
    row.statusBeforeForget = row.status;
    row.status = 'forgotten';
    return 'forgotten';
  }
  if (row.status === 'forgotten') {
    row.status = row.statusBeforeForget ?? 'active';
    row.statusBeforeForget = null;
    row.forgetReason = null;
    return 'restored';
  }
  if (row.status === 'active' && row.approvedAt !== null) {
    return null;
  }
  row.status = 'active';
  row.approvedAt ??= now;
  return 'approved';
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
  row.approvedAt = null;
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
    approvedAt: row.approvedAt?.toISOString() ?? null,
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
