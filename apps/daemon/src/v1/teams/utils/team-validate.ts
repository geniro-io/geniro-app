import { BadRequestException } from '@packages/common';

import { INSTRUCTION_BLOCK_EVERYONE, type Team } from '../teams.types';
import { validateStages } from './stage-validate';

export type TeamIssueCode =
  | 'TEAM_NO_MEMBERS'
  | 'TEAM_DUPLICATE_MEMBER'
  | 'TEAM_TRIGGER_COUNT'
  | 'TEAM_TRIGGER_UNKNOWN'
  | 'TEAM_DUPLICATE_BLOCK'
  | 'TEAM_AUDIENCE_UNKNOWN';

export interface TeamIssue {
  code: string;
  message: string;
}

export interface TeamValidation {
  errors: TeamIssue[];
  warnings: TeamIssue[];
}

function duplicates(ids: readonly string[]): string[] {
  return [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
}

/**
 * Whether a team holds together: at least one member, unique ids, exactly one
 * trigger naming a member, and a walkable stage graph. An id a block's
 * audience or a stage's responsible list names that is no member is a
 * warning — it is left out of what members are told, never guessed.
 *
 * TWIN PARSER: `validateTeam` in apps/ui/src/renderer/teams/team-validate.ts.
 */
export function validateTeam(team: Team): TeamValidation {
  const errors: TeamIssue[] = [];
  const warnings: TeamIssue[] = [];
  const memberIds = team.members.map((member) => member.id);
  const known = new Set(memberIds);

  if (team.members.length === 0) {
    errors.push({
      code: 'TEAM_NO_MEMBERS',
      message: 'A team needs at least one member',
    });
  }
  const twice = duplicates(memberIds);
  if (twice.length > 0) {
    errors.push({
      code: 'TEAM_DUPLICATE_MEMBER',
      message: `Duplicate member id(s): ${twice.join(', ')}`,
    });
  }
  if (team.triggers.length !== 1) {
    errors.push({
      code: 'TEAM_TRIGGER_COUNT',
      message: `A team has exactly one trigger, the first message; this one has ${team.triggers.length}`,
    });
  }
  for (const trigger of team.triggers) {
    if (!known.has(trigger.member)) {
      errors.push({
        code: 'TEAM_TRIGGER_UNKNOWN',
        message: `The first message is handled by '${trigger.member}', which is not a member of this team`,
      });
    }
  }
  const blockTwice = duplicates(
    team.instructionBlocks.map((block) => block.id),
  );
  if (blockTwice.length > 0) {
    errors.push({
      code: 'TEAM_DUPLICATE_BLOCK',
      message: `Duplicate instruction block id(s): ${blockTwice.join(', ')}`,
    });
  }
  for (const block of team.instructionBlocks) {
    if (block.audience === INSTRUCTION_BLOCK_EVERYONE) {
      continue;
    }
    for (const id of block.audience) {
      if (!known.has(id)) {
        warnings.push({
          code: 'TEAM_AUDIENCE_UNKNOWN',
          message: `Instruction block '${block.title || block.id}' is addressed to '${id}', which is not a member of this team; it reaches the others only`,
        });
      }
    }
  }

  const stages = validateStages(team);
  return {
    errors: [...errors, ...stages.errors],
    warnings: [...warnings, ...stages.warnings],
  };
}

/** Throws the first {@link validateTeam} error. */
export function assertValidTeam(team: Team): void {
  const [first] = validateTeam(team).errors;
  if (first !== undefined) {
    throw new BadRequestException(first.code, first.message);
  }
}
