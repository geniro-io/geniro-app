import type { Team } from '../teams.types';
import { teamStrings } from './team-edits';

/** A string past this length, or holding a line break, is a text: the outline sizes it, a part writes it out as a field of its own. */
const SHORT_TEXT_MAX = 160;

/** How much of one paragraph a search hit shows, around its first match. */
const HIT_PARAGRAPH_MAX = 1_500;

/** The parts of a team one read asks for, each by id. */
export interface TeamSelection {
  members?: readonly string[];
  blocks?: readonly string[];
  stages?: boolean;
}

function isText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    (value.length > SHORT_TEXT_MAX || value.includes('\n'))
  );
}

function entriesOf(value: object): [string, unknown][] {
  return Object.entries(value);
}

/** The team's own fields: everything but its lists of members, blocks and stages. */
const LISTS = new Set(['members', 'instructionBlocks', 'stages']);

function teamFields(team: Team): Record<string, unknown> {
  return Object.fromEntries(entriesOf(team).filter(([key]) => !LISTS.has(key)));
}

function sized(value: object, readWith: string): Record<string, unknown> {
  return Object.fromEntries(
    entriesOf(value).map(([key, field]) => [
      key,
      isText(field) ? `⟨${field.length} characters — read ${readWith}⟩` : field,
    ]),
  );
}

/**
 * The team at a glance: its own fields, and every member, block and stage
 * with its short fields as they are and each text replaced by its size and
 * the read that answers it.
 */
export function teamOutline(team: Team): Record<string, unknown> {
  return {
    ...sized(teamFields(team), 'with full=true'),
    members: team.members.map((member) =>
      sized(member, `with members=["${member.id}"]`),
    ),
    instructionBlocks: team.instructionBlocks.map((block) =>
      sized(block, `with blocks=["${block.id}"]`),
    ),
    ...(team.stages === undefined
      ? {}
      : {
          stages: team.stages.map((stage) => sized(stage, 'with stages=true')),
        }),
  };
}

/**
 * One part of the team written out under `heading`: its short fields as one
 * JSON line, then each text between markers naming its path — the path an
 * edit's `path` takes (`path` is the part's own, empty for the team's own
 * fields), and the exact text a `find` is copied from.
 */
function partText(heading: string, path: string, value: object): string {
  const short = Object.fromEntries(
    entriesOf(value).filter(([, field]) => !isText(field)),
  );
  const texts = entriesOf(value).filter((entry): entry is [string, string] =>
    isText(entry[1]),
  );
  return [
    `## ${heading}`,
    JSON.stringify(short),
    ...texts.map(([key, text]) => {
      const at = path === '' ? key : `${path}/${key}`;
      return `=== ${at} · ${text.length} characters ===\n${text}\n=== end ${at} ===`;
    }),
  ].join('\n\n');
}

/**
 * The parts `selection` names written out in the team's order, or the ids it
 * names that the team does not have.
 */
export function teamPartsText(
  team: Team,
  selection: TeamSelection | 'all',
): { ok: true; text: string } | { ok: false; unknown: string[] } {
  const all = selection === 'all';
  const wanted = selection === 'all' ? {} : selection;
  const wantedMembers = new Set(wanted.members ?? []);
  const wantedBlocks = new Set(wanted.blocks ?? []);
  const wantsStages = all || wanted.stages === true;
  const unknown = [
    ...[...wantedMembers]
      .filter((id) => !team.members.some((member) => member.id === id))
      .map((id) => `member ${id}`),
    ...[...wantedBlocks]
      .filter((id) => !team.instructionBlocks.some((block) => block.id === id))
      .map((id) => `block ${id}`),
  ];
  if (unknown.length > 0) {
    return { ok: false, unknown };
  }
  const parts = [
    ...(all ? [partText('team', '', teamFields(team))] : []),
    ...team.members
      .filter((member) => all || wantedMembers.has(member.id))
      .map((member) =>
        partText(`members/${member.id}`, `members/${member.id}`, member),
      ),
    ...team.instructionBlocks
      .filter((block) => all || wantedBlocks.has(block.id))
      .map((block) =>
        partText(
          `instructionBlocks/${block.id}`,
          `instructionBlocks/${block.id}`,
          block,
        ),
      ),
    ...(wantsStages
      ? (team.stages ?? []).map((stage) =>
          partText(`stages/${stage.id}`, `stages/${stage.id}`, stage),
        )
      : []),
  ];
  return {
    ok: true,
    text:
      parts.length === 0 && wantsStages
        ? 'The team has no stages.'
        : parts.join('\n\n'),
  };
}

function clippedAround(paragraph: string, needles: readonly string[]): string {
  if (paragraph.length <= HIT_PARAGRAPH_MAX) {
    return paragraph;
  }
  const lower = paragraph.toLowerCase();
  const first = Math.min(
    ...needles.map((needle) => lower.indexOf(needle)).filter((at) => at >= 0),
  );
  const start = Math.max(0, first - Math.floor(HIT_PARAGRAPH_MAX / 3));
  const end = Math.min(paragraph.length, start + HIT_PARAGRAPH_MAX);
  return `${start > 0 ? '…' : ''}${paragraph.slice(start, end)}${end < paragraph.length ? '…' : ''}`;
}

/**
 * Every paragraph of the team's texts that holds one of `terms`, ignoring
 * case, under the path of the field it is in — where a change to a subject
 * has to land, found in one read. A paragraph past {@link HIT_PARAGRAPH_MAX}
 * is cut around its first match, the cut marked `…`.
 */
export function teamSearchText(
  team: Team,
  terms: readonly string[],
): { text: string; paragraphs: number; fields: number } {
  const needles = terms
    .map((term) => term.trim().toLowerCase())
    .filter((needle) => needle !== '');
  let paragraphs = 0;
  const sections = teamStrings(team).flatMap(({ path, text }) => {
    const all = text.split(/\n[ \t]*\n/);
    const hits = all.filter((paragraph) => {
      const lower = paragraph.toLowerCase();
      return needles.some((needle) => lower.includes(needle));
    });
    if (hits.length === 0) {
      return [];
    }
    paragraphs += hits.length;
    return [
      `=== ${path} · ${hits.length} of ${all.length} paragraphs ===\n${hits
        .map((paragraph) => clippedAround(paragraph, needles))
        .join('\n\n')}\n=== end ${path} ===`,
    ];
  });
  return {
    text: sections.join('\n\n'),
    paragraphs,
    fields: sections.length,
  };
}
