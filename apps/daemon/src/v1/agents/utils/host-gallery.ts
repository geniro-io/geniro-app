import { HOST_GALLERY_TOOL } from '../chat.types';
import { isHostToolCall } from './host-tool';
import { isRemoteImageUrl } from './remote-image';

/**
 * Whether a permission request names geniro's OWN gallery tool.
 *
 * Auto-approved on the family's reading: what the agent is asking to run is the
 * act of DRAWING in this app's own transcript, and local pictures are read by
 * the RENDERER afterwards, through the image route's own guards. A call naming
 * a picture by URL is the exception — see {@link hostGalleryDownloads}.
 *
 * How the pair is matched belongs to {@link isHostToolCall}.
 */
export function isHostGalleryCall(
  serverName: string | null,
  toolName: string,
): boolean {
  return isHostToolCall(serverName, toolName, HOST_GALLERY_TOOL);
}

/**
 * Whether a gallery call's arguments name a picture by http(s) URL, which the
 * daemon downloads from a host the agent chose — so outside `auto` the call is
 * put to the user like the agent's own fetch would be (user decision).
 *
 * Any string in the arguments that is a URL counts, wherever it sits: the
 * arguments arrive in each CLI's own wrapping, and asking once too often is the
 * safe way to be wrong — which is also why arguments the CLI did not relay
 * (cursor sends an empty bag as null) count as a download.
 */
export function hostGalleryDownloads(input: unknown): boolean {
  if (
    input === null ||
    input === undefined ||
    (typeof input === 'object' &&
      !Array.isArray(input) &&
      Object.keys(input).length === 0)
  ) {
    return true;
  }
  return namesUrl(input);
}

function namesUrl(input: unknown): boolean {
  if (typeof input === 'string') {
    return isRemoteImageUrl(input);
  }
  if (Array.isArray(input)) {
    return input.some(namesUrl);
  }
  if (typeof input === 'object' && input !== null) {
    return Object.values(input).some(namesUrl);
  }
  return false;
}
