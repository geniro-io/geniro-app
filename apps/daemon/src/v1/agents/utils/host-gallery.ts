import { HOST_GALLERY_TOOL } from '../chat.types';
import { isHostToolCall } from './host-tool';

/**
 * Whether a permission request names geniro's OWN gallery tool.
 *
 * Auto-approved on the family's reading: what the agent is asking to run is the
 * act of DRAWING in this app's own transcript. The pictures are read by the
 * RENDERER afterwards, through the image route's own guards, so nothing this
 * call does reaches the disk and a card guarding it would fire on every gallery
 * to protect nothing.
 *
 * How the pair is matched belongs to {@link isHostToolCall}.
 */
export function isHostGalleryCall(
  serverName: string | null,
  toolName: string,
): boolean {
  return isHostToolCall(serverName, toolName, HOST_GALLERY_TOOL);
}
