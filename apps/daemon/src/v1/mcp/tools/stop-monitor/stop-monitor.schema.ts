import { withSynonymProperties } from '../../../../utils/tool-arg-synonyms';
import { STOP_MONITOR_SYNONYMS } from './stop-monitor.reader';

/** `stop_monitor`'s arguments. */
export function stopMonitorSchema(): Record<string, unknown> {
  return withSynonymProperties(
    {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'The id monitor reported, e.g. "m1".',
        },
      },
      required: ['id'],
    },
    STOP_MONITOR_SYNONYMS,
  );
}
