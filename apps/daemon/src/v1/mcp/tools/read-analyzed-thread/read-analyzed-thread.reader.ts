import {
  ANALYSIS_RUNS_SECTIONS,
  ANALYSIS_SPEND_SECTIONS,
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
const HISTORY_RECORD_SECTIONS = [
  'versions',
  'changeLog',
  'recommendations',
  'members',
] as const;

type SpendSection = (typeof ANALYSIS_SPEND_SECTIONS)[number];
type RunsSection = (typeof ANALYSIS_RUNS_SECTIONS)[number];
type RecordSection =
  (typeof HISTORY_RECORD_SECTIONS)[number] | SpendSection | RunsSection;

/** Room a page keeps for what surrounds its records. */
const SECTION_ENVELOPE_BYTES = 200;

/** A section's records as a page lists them: a version's diff is read on request. */
function sectionRecords(answer: Answer, section: RecordSection): unknown[] {
  const list = answer[section];
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

/** How many records each section holds and how large it is. */
function sectionSizes(
  answer: Answer,
  sections: readonly RecordSection[],
): Record<string, { records: number; bytes: number }> {
  const sizes: Record<string, { records: number; bytes: number }> = {};
  for (const section of sections) {
    const records = sectionRecords(answer, section);
    sizes[section] = { records: records.length, bytes: bytes(records) };
  }
  return sizes;
}

/** What a history too long for one page answers first: its summary and each section's size. */
function historySummary(history: Answer): Answer {
  const diffs = (
    Array.isArray(history.versions) ? history.versions : []
  ).flatMap((record) => {
    const diff = asRecord(asRecord(record)?.changes)?.diff;
    return typeof diff === 'string' && diff !== '' ? [diff] : [];
  });
  return {
    team: history.team,
    currentVersion: history.currentVersion,
    summary: history.summary,
    sections: {
      ...sectionSizes(history, HISTORY_RECORD_SECTIONS),
      diffs: { versions: diffs.length, bytes: bytes(diffs) },
    },
    note: 'This history is longer than one page, so it is read by section: pass `section` and follow each page\'s `next`. A version\'s diff is section="diff" version=<its number>: read it for a change you are judging, never every diff.',
    next: { section: 'versions', offset: 0 },
  };
}

/** One page of a section, cut between records; a record past a page comes in parts. */
function sectionPage(
  answer: Answer,
  section: RecordSection,
  offset: number,
  part: number,
): Answer {
  const records = sectionRecords(answer, section);
  const head = { team: answer.team, section };
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

function isSpendSection(section: string): section is SpendSection {
  return (ANALYSIS_SPEND_SECTIONS as readonly string[]).includes(section);
}

function isRunsSection(section: string): section is RunsSection {
  return (ANALYSIS_RUNS_SECTIONS as readonly string[]).includes(section);
}

function wrongSection(view: string, section: string): Answer {
  return {
    error: 'INVALID_ARGS',
    message: `view=${view} has no section "${section}".`,
  };
}

/**
 * A team's spend, masked whole by the caller, as one page: the whole of it while
 * it fits, else its windows and largest writes, then one breakdown at a time.
 * Later pages come from a fresh fold over live ledgers, so each stands alone.
 */
export function spendAnswer(
  spend: Answer,
  query: ReadAnalyzedThreadArgs,
): Answer {
  if (query.section !== undefined) {
    return isSpendSection(query.section)
      ? sectionPage(spend, query.section, query.offset ?? 0, query.part ?? 0)
      : wrongSection('spend', query.section);
  }
  if (bytes(spend) <= PAGE_BYTES) {
    return spend;
  }
  const rest = Object.entries(spend).filter(
    ([key]) => !isSpendSection(key) && key !== 'next',
  );
  return {
    ...Object.fromEntries(rest),
    sections: sectionSizes(spend, ANALYSIS_SPEND_SECTIONS),
    note: "This answer is longer than one page, so its breakdowns are read by section: pass `section` and follow each page's `next`.",
    next: { section: 'byMember', offset: 0 },
  };
}

/**
 * A page of the team's runs outside the sample, from a fresh read like spend's:
 * a run started meanwhile moves the list down, so a record can repeat on the
 * next page and none is missed.
 */
export function otherRunsAnswer(
  runs: Answer,
  query: ReadAnalyzedThreadArgs,
): Answer {
  const section = query.section ?? '';
  return isRunsSection(section)
    ? {
        ...sectionPage(runs, section, query.offset ?? 0, query.part ?? 0),
        note: 'Open one with runId, only for a concrete question.',
      }
    : wrongSection('runs', section);
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
    return isSpendSection(query.section) || isRunsSection(query.section)
      ? wrongSection('history', query.section)
      : sectionPage(history, query.section, offset, query.part ?? 0);
  }
  if (offset > 0) {
    return pagedAnswer(history, offset);
  }
  return bytes(history) <= PAGE_BYTES ? history : historySummary(history);
}
