import type { Run } from '../../runs/entity/run.entity';
import { AgentKind, AgentKindSchema } from '../../runs/runs.types';
import type { LessonsConfig, ReflectLessons } from '../lessons.types';

/** What a reflection on one thread runs as. */
export interface ReflectionChoice {
  agentKind: AgentKind;
  model: string | null;
  effort: string | null;
  configDir: string | null;
}

/**
 * The agent, model and effort a reflection on `source` runs as: what the press
 * named, else the lessons settings, else the thread's own CLI and its default.
 * A settings model or effort belongs to the settings agent, so a press naming
 * another agent drops them.
 */
export function reflectionChoiceOf(
  settings: LessonsConfig,
  source: Pick<Run, 'agentKind' | 'configDir'>,
  input: Pick<ReflectLessons, 'agentKind' | 'model' | 'effort' | 'configDir'>,
): ReflectionChoice {
  const settingsAgent = AgentKindSchema.safeParse(settings.agentKind);
  const agentKind =
    input.agentKind ??
    (settingsAgent.success ? settingsAgent.data : null) ??
    source.agentKind ??
    AgentKind.Claude;
  const fromSettings =
    settings.agentKind === null || settings.agentKind === agentKind;
  return {
    agentKind,
    model: input.model ?? (fromSettings ? settings.model : null),
    effort: input.effort ?? (fromSettings ? settings.effort : null),
    configDir:
      input.configDir ??
      (source.agentKind === agentKind ? source.configDir : null),
  };
}
