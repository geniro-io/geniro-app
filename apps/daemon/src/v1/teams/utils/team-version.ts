import { createHash } from 'node:crypto';

import { Document } from 'yaml';

import { type LegacyTeamGraph, type Team, TeamSchema } from '../teams.types';
import {
  isLegacyTeamGraph,
  teamFromLegacyDocument,
} from './team-from-workflow';

/**
 * The part of a team that decides how a run executes: the coordination mode,
 * the members, the trigger, the instruction blocks and the stage graph, each
 * list in its authored order (member and block order shape every prompt), and
 * the active-turn cap. The team's own name and description are left out, so
 * editing them never makes a new version.
 */
export interface CanonicalTeam {
  maxActiveTurns: number | null;
  mode: Team['mode'];
  members: Team['members'];
  triggers: Team['triggers'];
  instructionBlocks: Team['instructionBlocks'];
  stages?: Team['stages'];
}

function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Plain JSON with object keys sorted at every depth and undefined keys dropped. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, field]) => field !== undefined)
        .sort(([a], [b]) => byText(a, b))
        .map(([key, field]) => [key, sortKeys(field)]),
    );
  }
  return value;
}

/**
 * Takes a team as the library and run snapshots both hold it — already
 * through `TeamYamlSchema`'s defaults — so a field the YAML left to its
 * default and the same field written out hash alike.
 */
export function canonicalGraphOf(team: Team): CanonicalTeam {
  return {
    maxActiveTurns: team.maxActiveTurns ?? null,
    mode: team.mode,
    members: team.members,
    triggers: team.triggers,
    instructionBlocks: team.instructionBlocks,
    stages: team.stages?.length ? team.stages : undefined,
  };
}

export function canonicalGraphJson(graph: CanonicalTeam): string {
  return JSON.stringify(sortKeys(graph));
}

/**
 * A run's team version: 16 hex of the canonical team's sha256. A stored
 * version is never recomputed, so a schema default added later changes the
 * version only of runs made after it.
 */
export function teamVersionOf(team: Team): string {
  return createHash('sha256')
    .update(canonicalGraphJson(canonicalGraphOf(team)))
    .digest('hex')
    .slice(0, 16);
}

/**
 * The version a node graph was recorded under while teams were graphs: the
 * same hash over its nodes sorted by id, its edges without their label sorted
 * by ends and kind, the cap and the stages — so a run started then still
 * finds its recorded version.
 */
export function legacyGraphVersionOf(graph: LegacyTeamGraph): string {
  return createHash('sha256')
    .update(legacyCanonicalJson(graph))
    .digest('hex')
    .slice(0, 16);
}

/** The canonical JSON {@link legacyGraphVersionOf} hashes — what a version row of that time holds. */
export function legacyCanonicalJson(graph: LegacyTeamGraph): string {
  const edgeKey = (edge: { from: string; to: string; kind: string }): string =>
    JSON.stringify([edge.from, edge.to, edge.kind]);
  return JSON.stringify(
    sortKeys({
      maxActiveTurns: graph.maxActiveTurns ?? null,
      nodes: [...graph.nodes].sort((a, b) => byText(a.id, b.id)),
      edges: graph.edges
        .map(({ label: _label, ...edge }) => edge)
        .sort((a, b) => byText(edgeKey(a), edgeKey(b))),
      stages: graph.stages?.length ? graph.stages : undefined,
    }),
  );
}

/**
 * A stored canonical team read back as a `Team` (under a placeholder name,
 * which the schema requires), or null when it no longer parses. A version
 * recorded while teams were node graphs is converted (`teamFromWorkflow`).
 */
export function teamOfCanonical(json: string): Team | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') {
    return null;
  }
  const { maxActiveTurns, ...rest } = parsed as Record<string, unknown>;
  const document = {
    ...rest,
    name: 'version',
    ...(typeof maxActiveTurns === 'number' ? { maxActiveTurns } : {}),
  };
  if (isLegacyTeamGraph(document)) {
    const legacy = teamFromLegacyDocument(document);
    return legacy.success ? legacy.converted.team : null;
  }
  const result = TeamSchema.safeParse(document);
  return result.success ? result.data : null;
}

/** Whether a stored canonical team was recorded while teams were node graphs. */
export function isLegacyCanonical(json: string): boolean {
  try {
    return isLegacyTeamGraph(JSON.parse(json));
  } catch {
    return false;
  }
}

/**
 * A stored canonical team as YAML in the library file's field order — what a
 * version's diff is taken over — or null when it no longer parses.
 */
export function canonicalGraphYaml(json: string): string | null {
  const team = teamOfCanonical(json);
  if (team === null) {
    return null;
  }
  const { maxActiveTurns, mode, members, triggers, instructionBlocks, stages } =
    team;
  // The JSON round trip drops undefined fields, as the library writer does.
  return new Document(
    JSON.parse(
      JSON.stringify({
        maxActiveTurns,
        mode,
        members,
        triggers,
        instructionBlocks,
        stages,
      }),
    ),
  ).toString();
}
