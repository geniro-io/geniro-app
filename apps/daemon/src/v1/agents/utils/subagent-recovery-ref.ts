import { z } from 'zod';

import { AgentKindSchema } from '../../runs/runs.types';

/**
 * The persisted shape of a delegate's recovery ref, the one definition of
 * `SubagentRecoveryRef`: a ref read back that fails it is treated as absent.
 */
export const SubagentRecoveryRefSchema = z.object({
  agentKind: AgentKindSchema,
  sessionId: z.string().min(1),
  cwd: z.string().min(1),
  configDir: z.string().nullable(),
  toolCallId: z.string().min(1),
  launchedAtMs: z.number().finite(),
  childSessionId: z.string().nullable(),
});
