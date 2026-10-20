/**
 * `propose_patch`'s argument reader and result text.
 *
 * They live in `agents/utils/host-patch.ts` (and are tested there) rather than
 * here because the agents module needs them too: a patch card DEFERRED on a
 * CLI that will not hold the call is re-read from its stored arguments
 * (`pending-question.ts`) and its verdict delivered as a message
 * (`ChatService`), and `v1/agents` may not import `v1/mcp`. One copy, named
 * from here so the tool's directory still has its four files.
 */
export {
  hostPatchResultText,
  type PatchRead,
  readHostPatch,
} from '../../../agents/utils/host-patch';
