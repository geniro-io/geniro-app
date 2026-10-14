import type { ItemCallIndexService } from '../services/item-call-index.service';
import { OUTSIDE_ANY_CALL } from '../utils/call-membership';

/**
 * A call index that files every row in the run's own flow — for specs of a
 * writer whose rows' membership they do not observe.
 */
export const NO_CALL_INDEX = {
  inCallOf: () => Promise.resolve(OUTSIDE_ANY_CALL),
  ensureIndexed: () => Promise.resolve(),
} as unknown as ItemCallIndexService;
