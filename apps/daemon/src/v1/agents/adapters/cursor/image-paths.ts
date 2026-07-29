import type { TurnImage } from '../adapter.types';

/**
 * Name the turn's attached images to cursor-agent by PATH.
 *
 * cursor-agent's `-p` stdin is a plain prompt string — it has no structured
 * content channel, so unlike claude (which gets real base64 image blocks) there
 * is nowhere to put bytes. The paths are stated plainly instead and the agent
 * opens them with its own file tools.
 *
 * UNVERIFIED against a live cursor-agent: the probe needs a signed-in CLI, and
 * the key lives in the user's Keychain. If a future probe shows cursor cannot
 * read an image file, this is the seam to change — the attachments are already
 * on disk, so no other layer moves.
 */
export function withImagePaths(prompt: string, images?: TurnImage[]): string {
  if (!images?.length) {
    return prompt;
  }
  const list = images.map((image) => `- ${image.path}`).join('\n');
  const header =
    images.length === 1
      ? 'The user attached this image file:'
      : 'The user attached these image files:';
  // Images first: a prompt that opens "what's wrong here?" reads as a dangling
  // question until the attachment it refers to is on the table.
  return `${header}\n${list}\n\n${prompt}`;
}
