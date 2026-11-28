/**
 * Geniro's capabilities that a tool row cannot describe, each counted as a
 * usage subject of kind `capability`. Registered at every boot so one never
 * used is reported as such.
 */
export const CAPABILITY_CATALOG = [
  'compaction',
  'subagent',
  'question_card',
  'permission_request',
  'thread_outcome',
  'agent_call',
  'stage_move',
  'lessons_reflection',
  'lessons_check',
  'thread_analysis',
  'team_analysis',
  'system_analysis',
  'prompt_cache_warmup',
  'automatic_flag',
  'autopilot_card_start',
  'card_start',
] as const;

export type CapabilityId = (typeof CAPABILITY_CATALOG)[number];

export function isCapabilityId(value: string): value is CapabilityId {
  return (CAPABILITY_CATALOG as readonly string[]).includes(value);
}
