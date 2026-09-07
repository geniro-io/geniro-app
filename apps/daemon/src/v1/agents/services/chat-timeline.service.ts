import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';
import { NotFoundException } from '@packages/common';

import type {
  ChatTimelineMarker,
  ChatTimelineSegment,
  ChatTimelineWire,
} from '../chat.types';
import { ItemDao } from '../dao/item.dao';
import { RunDao } from '../dao/run.dao';
import { messageText } from '../utils/message-preview';
import { sumUsagePayloads } from '../utils/usage-figures';

/**
 * How much of a user message one marker carries.
 *
 * Shorter than the search snippet's 200, because that row is read on its own
 * while this one is a label on a rail with a dozen neighbours: past a line it
 * stops being scannable, which is the only thing the rail is better at than
 * scrolling the transcript.
 */
const PREVIEW_MAX_CHARS = 120;

/**
 * How many markers one rail carries, newest kept.
 *
 * Generous rather than tight — the measured worst case on a real install is 242
 * markers over a 26,000-row run — because the rail's whole promise is the WHOLE
 * thread, and a cap that trips routinely would break it for the conversations
 * it exists for. What the bound actually buys is that the response cannot grow
 * without limit on a thread nobody has written yet, and, when it does trip, the
 * rail says so rather than passing a slice off as the conversation.
 */
const MAX_TIMELINE_MARKERS = 200;

/**
 * The conversation as a rail of its user messages.
 *
 * A daemon route rather than a fold in the client, for `ChatSearchService`'s
 * reason: the renderer holds at most `HISTORY_PAGE` items, so a timeline folded
 * from those describes the loaded WINDOW rather than the thread — and reports a
 * shorter, cheaper conversation than the one that happened, with nothing on
 * screen saying so.
 *
 * Its own service rather than another method on `ChatService`, which is already
 * the largest class in the module and owns turn execution; this reads two
 * projections and folds them.
 */
@Injectable()
export class ChatTimelineService {
  constructor(
    private readonly em: EntityManager,
    private readonly itemDao: ItemDao,
    private readonly runDao: RunDao,
  ) {}

  async read(runId: string): Promise<ChatTimelineWire> {
    const em = this.em.fork();
    // Checked rather than inferred from an empty rail: "this conversation does
    // not exist" and "nobody has said anything in it" are different answers,
    // and only the first is a 4xx.
    if ((await this.runDao.getById(runId, em)) === null) {
      throw new NotFoundException('RUN_NOT_FOUND', `no run: ${runId}`);
    }
    const [spine, payloadRows] = await Promise.all([
      this.itemDao.timelineSpine(runId, em),
      this.itemDao.timelinePayloadRows(runId, em),
    ]);
    const markers = this.fold(spine, payloadRows);
    if (markers.length <= MAX_TIMELINE_MARKERS) {
      return { markers, partialReason: null };
    }
    // The NEWEST are kept, and they stay in seq order: a rail reads left to
    // right through the conversation, so returning the tail reversed would put
    // the thread backwards rather than shortening it.
    return {
      markers: markers.slice(-MAX_TIMELINE_MARKERS),
      partialReason: `showing the newest ${MAX_TIMELINE_MARKERS} messages — the conversation starts earlier than this rail does`,
    };
  }

  /**
   * Both inputs arrive in seq order, so one forward walk of each fills every
   * segment — rather than a filter per marker, which is quadratic on exactly
   * the long conversations this route exists for.
   */
  private fold(
    spine: readonly TimelineSpineRow[],
    payloadRows: readonly TimelinePayloadRow[],
  ): ChatTimelineMarker[] {
    const drafts: SegmentDraft[] = [];
    let open: SegmentDraft | null = null;
    for (const row of spine) {
      if (isUserMessage(row)) {
        open = {
          seq: row.seq,
          createdAt: row.createdAt,
          aiMessages: 0,
          lastAt: null,
          preview: '',
          turnPayloads: [],
        };
        drafts.push(open);
        continue;
      }
      // Rows before the first user message belong to no marker — the rail is
      // of user messages, so it starts at one.
      if (open === null) {
        continue;
      }
      open.lastAt = row.createdAt;
      if (isAgentMessage(row)) {
        open.aiMessages += 1;
      }
    }

    // The second walk advances through the same drafts: a user-message row
    // opens the draft it belongs to, and every later row files against it.
    let at = -1;
    for (const row of payloadRows) {
      while (at + 1 < drafts.length && drafts[at + 1]!.seq <= row.seq) {
        at += 1;
      }
      const draft = drafts[at];
      if (draft === undefined) {
        continue;
      }
      if (row.kind === 'turn_complete') {
        draft.turnPayloads.push(row.payload);
      } else if (row.seq === draft.seq) {
        draft.preview = previewOf(row.payload);
      }
    }

    return drafts.map((draft) => ({
      seq: draft.seq,
      createdAt: draft.createdAt.toISOString(),
      preview: draft.preview,
      segment: {
        aiMessages: draft.aiMessages,
        elapsedMs:
          draft.lastAt === null
            ? null
            : draft.lastAt.getTime() - draft.createdAt.getTime(),
        totals: sumUsagePayloads(draft.turnPayloads),
      } satisfies ChatTimelineSegment,
    }));
  }
}

type TimelineSpineRow = {
  seq: number;
  kind: string;
  role: string | null;
  createdAt: Date;
};

type TimelinePayloadRow = { seq: number; kind: string; payload: string };

type SegmentDraft = {
  seq: number;
  createdAt: Date;
  aiMessages: number;
  lastAt: Date | null;
  preview: string;
  turnPayloads: string[];
};

function isUserMessage(row: TimelineSpineRow): boolean {
  return row.kind === 'message' && row.role === 'user';
}

/**
 * The same discriminator the renderer's own transcript fold uses — a `message`
 * row that is not the user's. Matching on `role === 'assistant'` instead would
 * drop every row a CLI files under some other name.
 *
 * A DELEGATE's output counts here too, and the field is named and described for
 * that rather than filtered: what separates a delegate's message from the main
 * thread's is `payload.parentToolUseId`, and the spine deliberately carries no
 * payload — reading one for every message row is the cost that projection
 * exists to avoid.
 */
function isAgentMessage(row: TimelineSpineRow): boolean {
  return row.kind === 'message' && row.role !== 'user';
}

/**
 * A marker's label: the message's own opening words on one line.
 *
 * Newlines are collapsed rather than cut at the first one, so a message that
 * opens with a blank line or a heading still labels its marker with something.
 */
function previewOf(payload: string): string {
  const text = messageText(payload);
  if (text === null) {
    return '';
  }
  const line = text.replace(/\s+/gu, ' ').trim();
  // Cut on CODE POINTS, not code units: a `slice` landing between the halves of
  // a surrogate pair leaves a lone surrogate, which renders as a replacement
  // character — and a message opening with an emoji is the common case, not an
  // exotic one.
  const points = [...line];
  return points.length <= PREVIEW_MAX_CHARS
    ? line
    : `${points
        .slice(0, PREVIEW_MAX_CHARS - 1)
        .join('')
        .trimEnd()}…`;
}
