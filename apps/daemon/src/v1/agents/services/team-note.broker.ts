import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable, Logger } from '@nestjs/common';

import type { ItemKind } from '../../runs/runs.types';
import {
  type ItemWire,
  TEAM_NOTE_MAX_CHARS,
  TEAM_NOTES_PER_RUN,
  TEAM_NOTES_REPLY_BUDGET_CHARS,
  type TeamNoteEntry,
  type TeamNotePayload,
  type TeamNotesQuery,
  type TeamNotesReadOutcome,
  type TeamNoteWriteInput,
  type TeamNoteWriteOutcome,
} from '../chat.types';
import { ItemDao } from '../dao/item.dao';
import { KeyedChain } from '../utils/keyed-chain';
import { foldTeamNotes } from '../utils/team-note-fold';
import { HostSinkBroker, type HostSinkUnavailable } from './host-sink.broker';

/** The conversation behind a call: who writes a note, and who reads them. */
export interface TeamNoteWriter {
  nodeId: string;
  /** Null for the node's own conversation. */
  conversationId: string | null;
  /** The call that conversation is answering right now, if any. */
  callId: string | null;
}

/**
 * One workflow node's end of the team-note tools, installed by the pass that
 * runs it. The broker owns validation, the cap, the fold and the record of
 * what each conversation was shown; the sink owns what only the run knows —
 * its seq-allocating write, which conversation a caller key is, and what each
 * agent is called.
 */
export interface TeamNoteSink {
  persistItem(
    nodeId: string | null,
    kind: ItemKind,
    role: string | null,
    payload: unknown,
  ): Promise<ItemWire>;
  writer(caller: string): TeamNoteWriter;
  agentName(nodeId: string): string;
}

/** A run's notes as the unread figure needs them: seq and author, oldest first. */
interface RunNoteIndex {
  seqs: Set<number>;
  notes: { seq: number; author: string }[];
  /**
   * Notes a newer note replaced. A default read never shows one, and its
   * replacement is the note to read, so it never counts as unread.
   */
  superseded: Set<number>;
}

/** A per-note allowance for what a reply prints around the text. */
const NOTE_OVERHEAD_CHARS = 200;

function authorKey(nodeId: string, conversationId: string | null): string {
  return `${nodeId}\u0000${conversationId ?? ''}`;
}

/**
 * The run-wide shared notes of a workflow's agents (`team_note` /
 * `team_notes`). Notes are `team_note` items, so the transcript row is the
 * only copy; what lives here is per launch — which notes each conversation
 * has been shown, and an index of who wrote which seq, rebuilt from the rows
 * on a run's first touch after a restart.
 *
 * A note counts as read only once a reply showed it, so a narrowed read
 * (one kind, one author, an older page) leaves the rest unread. A superseded
 * note never counts: a default read never shows it, and its replacement is
 * the note to read. After a restart nothing has been shown, so every other
 * note a conversation did not write counts again: the figure over-reports
 * rather than hides a note.
 */
@Injectable()
export class TeamNoteBroker extends HostSinkBroker<TeamNoteSink> {
  private readonly indexes = new Map<string, RunNoteIndex>();
  private readonly loading = new Map<string, Promise<RunNoteIndex>>();
  private readonly loadLog = new Logger(TeamNoteBroker.name);
  /** Per run, per author key: every seq a `team_notes` reply showed it. */
  private readonly shown = new Map<string, Map<string, Set<number>>>();
  /** Per run, the tail of its write chain. */
  private readonly writes = new KeyedChain();

  constructor(
    private readonly em: EntityManager,
    private readonly itemDao: ItemDao,
  ) {
    super();
  }

  /** Whether this node is offered the team-note tools. */
  canUse(runId: string, nodeId: string): boolean {
    return this.has(runId, nodeId);
  }

  /**
   * Load the run's note index ahead of the first unread figure — the figure
   * is read synchronously on wake paths, and reads 0 until this settles.
   */
  async prime(runId: string): Promise<void> {
    try {
      await this.indexOf(runId);
    } catch (err) {
      this.loadLog.warn(
        `run ${runId} could not load its team notes: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async write(
    runId: string,
    nodeId: string,
    caller: string,
    input: TeamNoteWriteInput,
  ): Promise<TeamNoteWriteOutcome | HostSinkUnavailable> {
    return this.deliver(
      runId,
      nodeId,
      'no workflow pass is running that could record it',
      'write a team note',
      (sink) =>
        this.writes.run(runId, () =>
          this.writeNow(runId, nodeId, caller, input, sink),
        ),
    );
  }

  async read(
    runId: string,
    nodeId: string,
    caller: string,
    query: TeamNotesQuery,
  ): Promise<TeamNotesReadOutcome | HostSinkUnavailable> {
    return this.deliver(
      runId,
      nodeId,
      'no workflow pass is running that could read them',
      'read the team notes',
      (sink) => this.readNow(runId, caller, query, sink),
    );
  }

  /**
   * How many notes this conversation has not been shown and did not write.
   * Synchronous for the wake paths; 0 while the run's index is not loaded.
   */
  unreadCount(
    runId: string,
    writer: { nodeId: string; conversationId: string | null },
  ): number {
    const index = this.indexes.get(runId);
    if (index === undefined) {
      void this.prime(runId);
      return 0;
    }
    return this.unreadIn(
      index,
      runId,
      authorKey(writer.nodeId, writer.conversationId),
    );
  }

  forgetRun(runId: string): void {
    this.indexes.delete(runId);
    this.loading.delete(runId);
    this.shown.delete(runId);
    this.writes.forget(runId);
  }

  private async writeNow(
    runId: string,
    nodeId: string,
    caller: string,
    input: TeamNoteWriteInput,
    sink: TeamNoteSink,
  ): Promise<TeamNoteWriteOutcome> {
    const text = input.text.trim();
    if (text.length === 0) {
      return { status: 'refused', reason: 'text is empty' };
    }
    if (text.length > TEAM_NOTE_MAX_CHARS) {
      return {
        status: 'refused',
        reason: `text is ${text.length} characters; the limit is ${TEAM_NOTE_MAX_CHARS}. Write the essentials and point to where the rest lives (a file, a PR, a page).`,
      };
    }
    const index = await this.indexOf(runId);
    if (input.supersedes !== undefined && !index.seqs.has(input.supersedes)) {
      return {
        status: 'refused',
        reason: `supersedes ${input.supersedes} names no team note of this run`,
      };
    }
    const count = await this.itemDao.teamNoteCount(runId, this.em.fork());
    if (count >= TEAM_NOTES_PER_RUN) {
      return {
        status: 'refused',
        reason: `this run already holds ${TEAM_NOTES_PER_RUN} team notes, the limit`,
      };
    }
    const writer = sink.writer(caller);
    const payload: TeamNotePayload = {
      kind: input.kind,
      text,
      ...(input.supersedes === undefined
        ? {}
        : { supersedes: input.supersedes }),
      nodeId: writer.nodeId,
      conversationId: writer.conversationId,
      ...(writer.callId === null ? {} : { callId: writer.callId }),
    };
    const item = await sink.persistItem(nodeId, 'team_note', null, payload);
    const author = authorKey(writer.nodeId, writer.conversationId);
    index.seqs.add(item.seq);
    index.notes.push({ seq: item.seq, author });
    if (input.supersedes !== undefined) {
      index.superseded.add(input.supersedes);
    }
    return {
      status: 'written',
      seq: item.seq,
      unread: this.unreadIn(index, runId, author),
    };
  }

  private async readNow(
    runId: string,
    caller: string,
    query: TeamNotesQuery,
    sink: TeamNoteSink,
  ): Promise<TeamNotesReadOutcome> {
    const writer = sink.writer(caller);
    const author = authorKey(writer.nodeId, writer.conversationId);
    const index = await this.indexOf(runId);
    const wanted = query.author?.trim().toLowerCase() ?? null;
    const matching = foldTeamNotes(
      await this.itemDao.teamNoteRows(runId, this.em.fork()),
    )
      .filter(
        (note) =>
          (query.includeSuperseded || note.supersededBy === null) &&
          (query.kinds.length === 0 || query.kinds.includes(note.kind)) &&
          (query.since === null || note.seq > query.since) &&
          (query.before === null || note.seq < query.before) &&
          (wanted === null ||
            note.nodeId.toLowerCase() === wanted ||
            sink.agentName(note.nodeId).toLowerCase() === wanted),
      )
      .reverse();

    const shown: TeamNoteEntry[] = [];
    let spent = 0;
    for (const note of matching) {
      const cost = note.text.length + NOTE_OVERHEAD_CHARS;
      if (
        shown.length >= query.limit ||
        (shown.length > 0 && spent + cost > TEAM_NOTES_REPLY_BUDGET_CHARS)
      ) {
        break;
      }
      shown.push({ ...note, author: sink.agentName(note.nodeId) });
      spent += cost;
    }

    const seen = this.shownTo(runId, author);
    for (const note of shown) {
      seen.add(note.seq);
    }
    const olderRemaining = matching.length - shown.length;
    return {
      status: 'read',
      notes: shown,
      olderRemaining,
      nextBefore: olderRemaining > 0 ? (shown.at(-1)?.seq ?? null) : null,
      unread: this.unreadIn(index, runId, author),
    };
  }

  private unreadIn(index: RunNoteIndex, runId: string, author: string): number {
    const seen = this.shown.get(runId)?.get(author);
    let unread = 0;
    for (const note of index.notes) {
      if (
        note.author !== author &&
        !index.superseded.has(note.seq) &&
        seen?.has(note.seq) !== true
      ) {
        unread += 1;
      }
    }
    return unread;
  }

  private shownTo(runId: string, author: string): Set<number> {
    let byAuthor = this.shown.get(runId);
    if (byAuthor === undefined) {
      byAuthor = new Map();
      this.shown.set(runId, byAuthor);
    }
    let seen = byAuthor.get(author);
    if (seen === undefined) {
      seen = new Set();
      byAuthor.set(author, seen);
    }
    return seen;
  }

  private indexOf(runId: string): Promise<RunNoteIndex> {
    const loaded = this.indexes.get(runId);
    if (loaded !== undefined) {
      return Promise.resolve(loaded);
    }
    let loading = this.loading.get(runId);
    if (loading === undefined) {
      loading = this.load(runId);
      this.loading.set(runId, loading);
    }
    return loading;
  }

  private async load(runId: string): Promise<RunNoteIndex> {
    try {
      const notes = foldTeamNotes(
        await this.itemDao.teamNoteRows(runId, this.em.fork()),
      );
      const index: RunNoteIndex = {
        seqs: new Set(notes.map((note) => note.seq)),
        notes: notes.map((note) => ({
          seq: note.seq,
          author: authorKey(note.nodeId, note.conversationId),
        })),
        superseded: new Set(
          notes.filter((note) => note.supersededBy !== null).map((n) => n.seq),
        ),
      };
      // A forget that landed while this read ran keeps the run forgotten.
      if (this.loading.has(runId)) {
        this.indexes.set(runId, index);
      }
      return index;
    } finally {
      this.loading.delete(runId);
    }
  }
}
