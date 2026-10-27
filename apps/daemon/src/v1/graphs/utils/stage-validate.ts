import { BadRequestException } from '@packages/common';

import {
  MAX_WORKFLOW_STAGES,
  type Workflow,
  type WorkflowStage,
} from '../graphs.types';

export type StageIssueCode =
  | 'STAGE_TOO_MANY'
  | 'STAGE_DUPLICATE_ID'
  | 'STAGE_NEXT_UNKNOWN'
  | 'STAGE_NEXT_DUPLICATE'
  | 'STAGE_NO_START'
  | 'STAGE_MULTIPLE_STARTS'
  | 'STAGE_CYCLE'
  | 'STAGE_OWNER_UNKNOWN';

export interface StageIssue {
  code: StageIssueCode;
  message: string;
  stageId?: string;
}

export interface StageValidation {
  errors: StageIssue[];
  warnings: StageIssue[];
}

export function stagesOf(
  workflow: Pick<Workflow, 'stages'>,
): readonly WorkflowStage[] | null {
  return workflow.stages !== undefined && workflow.stages.length > 0
    ? workflow.stages
    : null;
}

/** TWIN PARSER: validateStages in apps/ui/src/renderer/workflows/stage-validate.ts. */
export function validateStages(
  workflow: Pick<Workflow, 'stages' | 'nodes'>,
): StageValidation {
  const errors: StageIssue[] = [];
  const warnings: StageIssue[] = [];
  const stages = stagesOf(workflow);
  if (stages === null) {
    return { errors, warnings };
  }
  if (stages.length > MAX_WORKFLOW_STAGES) {
    errors.push({
      code: 'STAGE_TOO_MANY',
      message: `A workflow may have at most ${MAX_WORKFLOW_STAGES} stages; this one has ${stages.length}`,
    });
  }

  const ids = new Set<string>();
  for (const stage of stages) {
    if (ids.has(stage.id)) {
      errors.push({
        code: 'STAGE_DUPLICATE_ID',
        message: `Two stages share the id '${stage.id}'`,
        stageId: stage.id,
      });
    }
    ids.add(stage.id);
  }

  const agentIds = new Set(
    workflow.nodes.filter((n) => n.kind === 'agent').map((n) => n.id),
  );
  const incoming = new Map<string, number>([...ids].map((id) => [id, 0]));
  for (const stage of stages) {
    const seen = new Set<string>();
    for (const next of stage.next ?? []) {
      if (seen.has(next)) {
        errors.push({
          code: 'STAGE_NEXT_DUPLICATE',
          message: `Stage '${stage.id}' lists '${next}' as a next stage twice`,
          stageId: stage.id,
        });
        continue;
      }
      seen.add(next);
      if (!ids.has(next)) {
        errors.push({
          code: 'STAGE_NEXT_UNKNOWN',
          message: `Stage '${stage.id}' names a next stage '${next}' that does not exist`,
          stageId: stage.id,
        });
        continue;
      }
      incoming.set(next, (incoming.get(next) ?? 0) + 1);
    }
    if (stage.ownerHint !== undefined && !agentIds.has(stage.ownerHint)) {
      warnings.push({
        code: 'STAGE_OWNER_UNKNOWN',
        message: `Stage '${stage.id}' is usually done by '${stage.ownerHint}', which is not an agent of this workflow; agents will read it as "any agent"`,
        stageId: stage.id,
      });
    }
  }
  if (errors.length > 0) {
    return { errors, warnings };
  }

  const starts = stages.filter((s) => incoming.get(s.id) === 0);
  if (starts.length === 0) {
    errors.push({
      code: 'STAGE_NO_START',
      message:
        'Every stage is named as a next stage, so none can come first — one stage must start the walk',
    });
    return { errors, warnings };
  }
  if (starts.length > 1) {
    errors.push({
      code: 'STAGE_MULTIPLE_STARTS',
      message: `Only one stage may start the walk; ${starts.map((s) => `'${s.id}'`).join(', ')} are each named by no other stage`,
    });
    return { errors, warnings };
  }

  const cycle = cycleIn(stages);
  if (cycle !== null) {
    errors.push({
      code: 'STAGE_CYCLE',
      message: `The stages loop back on themselves: ${cycle.join(' → ')}`,
      stageId: cycle[0],
    });
    return { errors, warnings };
  }

  return { errors, warnings };
}

function cycleIn(stages: readonly WorkflowStage[]): string[] | null {
  const byId = new Map(stages.map((s) => [s.id, s]));
  const done = new Set<string>();
  const path: string[] = [];
  const onPath = new Set<string>();
  const visit = (id: string): string[] | null => {
    if (onPath.has(id)) {
      return [...path.slice(path.indexOf(id)), id];
    }
    if (done.has(id)) {
      return null;
    }
    onPath.add(id);
    path.push(id);
    for (const next of byId.get(id)?.next ?? []) {
      const found = visit(next);
      if (found !== null) {
        return found;
      }
    }
    path.pop();
    onPath.delete(id);
    done.add(id);
    return null;
  };
  for (const stage of stages) {
    const found = visit(stage.id);
    if (found !== null) {
      return found;
    }
  }
  return null;
}

export function walkableStages(
  workflow: Pick<Workflow, 'stages' | 'nodes'>,
): readonly WorkflowStage[] | null {
  const stages = stagesOf(workflow);
  return stages !== null && validateStages(workflow).errors.length === 0
    ? stages
    : null;
}

export function assertValidStages(
  workflow: Pick<Workflow, 'stages' | 'nodes'>,
): void {
  const [first] = validateStages(workflow).errors;
  if (first !== undefined) {
    throw new BadRequestException(first.code, first.message);
  }
}

export function startStageId(stages: readonly WorkflowStage[]): string {
  const named = new Set(stages.flatMap((s) => s.next ?? []));
  const start = stages.find((s) => !named.has(s.id));
  if (start === undefined) {
    throw new BadRequestException(
      'STAGE_NO_START',
      'The stage graph has no first stage',
    );
  }
  return start.id;
}
