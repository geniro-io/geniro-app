import type { CliKind } from '../../shared/contracts';
import type { CliAgentDescriptor } from './agent-descriptor';
import { CLAUDE_DESCRIPTOR } from './claude';
import { CODEX_DESCRIPTOR } from './codex';
import { CURSOR_AGENT_DESCRIPTOR } from './cursor-agent';

/**
 * Every agent CLI the main process can probe, keyed by kind. A total `Record`,
 * so a `CliKind` added without a descriptor is a COMPILE error rather than a
 * CLI whose probes silently answer nothing.
 */
export const AGENT_DESCRIPTORS: Readonly<Record<CliKind, CliAgentDescriptor>> =
  {
    claude: CLAUDE_DESCRIPTOR,
    'cursor-agent': CURSOR_AGENT_DESCRIPTOR,
    codex: CODEX_DESCRIPTOR,
  };

/** One CLI's descriptor. */
export function descriptorFor(kind: CliKind): CliAgentDescriptor {
  return AGENT_DESCRIPTORS[kind];
}
