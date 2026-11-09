import {
  type ANALYSIS_HISTORY_SECTIONS,
  type ReadAnalyzedThreadArgs,
  ReadAnalyzedThreadArgsSchema,
} from '../../../agents/chat.types';
import {
  bytes,
  chunkOf,
  PAGE_BYTES,
  pagedAnswer,
} from '../../../agents/services/thread-reader.service';
import { asRecord } from '../../../agents/utils/json-util';
import { redactSecrets } from '../../../diagnostics/utils/redact';
import type { ToolArgs } from '../../mcp.types';
import { historyResultText } from '../history-mcp-tool';
import { readToolArgs } from '../tool-args';

/** A `read_analyzed_thread` call's query, or why it cannot be read. */
export function readAnalyzedThreadArgs(
  args: Record<string, unknown>,
): ToolArgs<ReadAnalyzedThreadArgs> {
  return readToolArgs(ReadAnalyzedThreadArgsSchema.strict(), args);
}

/**
 * One page as the agent reads it: the data-not-instructions line first — a
 * page quoted from another thread can arrive many turns after the description
 * was read — and every registered secret masked over the whole text.
 */
export function analyzedThreadResultText(answer: unknown): string {
  return redactSecrets(historyResultText(answer));
}

type Answer = Record<string, unknown>;
type RecordSection = Exclude<(typeof ANALYSIS_HISTORY_SECTIONS)[number], 'diff'>;

const RECORD_SECTIONS: readonly RecordSection[] = [
  'versions',
  'changeLog',
  'recommendations',
  'members',
];

/** Room a page keeps for what surrounds its records. */
const SECTION_ENVELOPE_BYTES = 200;

/** A section's records as a page lists them: a version's diff is read on request. */
function sectionRecords(history: Answer, section: RecordSection): unknown[] {
  const list = history[section];
  const records = Array.isArray(list) ? (list as unknown[]) : [];
  if (section !== 'versions') {
    return records;
  }
  return records.map((record) => {
    const version = asRecord(record);
    const changes = asRecord(version?.changes);
    return version === null || changes === null
      ? record
      : {
          ...version,
          changes: { added: changes.added, removed: changes.removed },
        };
  });
}

/** What a history too long for one page answers first: its summary and each section's size. */
function historySummary(history: Answer): Answer {
  const sections: Record<string, { records: number; bytes: number }> = {};
  for (const section of RECORD_SECTIONS) {
    const records = sectionRecords(history, section);
    sections[section] = { records: records.length, bytes: bytes(records) };
  }
  const diffs = (Array.isArray(history.versions) ? history.versions : []).flatMap(
    (record) => {
      const diff = asRecord(asRecord(record)?.changes)?.diff;
      return typeof diff === 'string' && diff !== '' ? [diff] : [];
    },
  );
  return {
    team: history.team,
    currentVersion: history.currentVersion,
    summary: history.summary,
    sections: {
      ...sections,
      diffs: { versions: diffs.length, bytes: bytes(diffs) },
    },
    note: 'This history is longer than one page, so it is read by section: pass `section` and follow each page\'s `next`. A version\'s diff is section="diff" version=<its number>: read it for a change you are judging, never every diff.',
    next: { section: 'versions', offset: 0 },
  };
}

/** One page of a section, cut between records; a record past a page comes in parts. */
function sectionPage(
  history: Answer,
  section: RecordSection,
  offset: number,
  part: number,
): Answer {
  const records = sectionRecords(history, section);
  const head = { team: history.team, section };
  const room = PAGE_BYTES - bytes(head) - SECTION_ENVELOPE_BYTES;
  const afterRecord = (index: number): Answer | null =>
    index < records.length ? { section, offset: index } : null;
  if (offset < records.length && bytes(records[offset]) > room) {
    const chunk = chunkOf(
      {
        ...head,
        records: records.length,
        record: offset,
        note: 'This one record is longer than a page: join the `text` of its parts (follow next.part), then parse it as JSON.',
      },
      JSON.stringify(records[offset]),
      part,
    );
    const nextPart = asRecord(chunk.next)?.offset;
    return {
      ...chunk,
      next:
        typeof nextPart === 'number'
          ? { section, offset, part: nextPart }
          : afterRecord(offset + 1),
    };
  }
  const page: unknown[] = [];
  let used = 0;
  let index = offset;
  for (; index < records.length; index += 1) {
    const size = bytes(records[index]) + 1;
    if (page.length > 0 && used + size > room) {
      break;
    }
    page.push(records[index]);
    used += size;
  }
  return {
    ...head,
    total: records.length,
    from: offset,
    records: page,
    next: afterRecord(index),
  };
}

/** One page of one version's diff, cut after a line whenever more remains. */
function diffPage(
  history: Answer,
  version: number | string | undefined,
  offset: number,
): Answer {
  if (version === undefined) {
    return {
      error: 'INVALID_ARGS',
      message:
        'section="diff" needs `version`: a number or hash from section="versions".',
    };
  }
  const versions = Array.isArray(history.versions) ? history.versions : [];
  const row = versions
    .map((record) => asRecord(record))
    .find((record) => {
      const ref = asRecord(record?.version);
      return (
        ref !== null &&
        (String(ref.number) === String(version) || ref.version === version)
      );
    });
  if (row === undefined || row === null) {
    return {
      error: 'UNKNOWN_VERSION',
      message: `No version ${version} in this team's history: section="versions" lists them.`,
    };
  }
  const head = { team: history.team, section: 'diff', version: row.version };
  const changes = asRecord(row.changes);
  if (changes === null) {
    return {
      ...head,
      note: 'This version has no diff: the version before it is not recorded, or one of the two no longer reads.',
      next: null,
    };
  }
  const chunk = chunkOf(
    { ...head, added: changes.added, removed: changes.removed },
    typeof changes.diff === 'string' ? changes.diff : '',
    offset,
  );
  if (chunk.next === null) {
    return chunk;
  }
  const text = chunk.text as string;
  const lineEnd = text.lastIndexOf('\n') + 1;
  const kept = lineEnd > 0 ? lineEnd : text.length;
  return {
    ...chunk,
    text: text.slice(0, kept),
    next: { section: 'diff', version, offset: offset + kept },
  };
}

/**
 * A team's history, masked whole by the caller, as one page: the whole of it
 * while it fits, else its summary and then one section at a time. An `offset`
 * with no section still cuts the old chunks of the whole answer.
 */
export function historyAnswer(
  history: Answer,
  query: ReadAnalyzedThreadArgs,
): Answer {
  const offset = query.offset ?? 0;
  if (query.section === 'diff') {
    return diffPage(history, query.version, offset);
  }
  if (query.section !== undefined) {
    return sectionPage(history, query.section, offset, query.part ?? 0);
  }
  if (offset > 0) {
    return pagedAnswer(history, offset);
  }
  return bytes(history) <= PAGE_BYTES ? history : historySummary(history);
}
