import { HOST_UI_TOOL } from '../chat.types';
import { isHostToolCall } from './host-tool';
import { isRemoteImageUrl } from './remote-image';

const MEDIA_FIELDS: Record<string, readonly string[]> = {
  Image: ['url'],
  Video: ['url', 'posterUrl'],
  AudioPlayer: ['url'],
};

export function isHostUiCall(
  serverName: string | null,
  toolName: string,
): boolean {
  return isHostToolCall(serverName, toolName, HOST_UI_TOOL);
}

/** Arguments the CLI did not relay count as a download, as for the gallery. */
export function hostUiDownloads(input: unknown): boolean {
  if (
    input === null ||
    input === undefined ||
    (typeof input === 'object' &&
      !Array.isArray(input) &&
      Object.keys(input).length === 0)
  ) {
    return true;
  }
  return namesMediaUrl(input);
}

function namesMediaUrl(input: unknown): boolean {
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return namesMediaUrl(JSON.parse(trimmed));
      } catch {
        return false;
      }
    }
    return false;
  }
  if (Array.isArray(input)) {
    return input.some(namesMediaUrl);
  }
  if (typeof input !== 'object' || input === null) {
    return false;
  }
  const record = input as Record<string, unknown>;
  const fields =
    typeof record.component === 'string'
      ? (MEDIA_FIELDS[record.component] ?? [])
      : [];
  if (
    fields.some(
      (field) =>
        typeof record[field] === 'string' && isRemoteImageUrl(record[field]),
    )
  ) {
    return true;
  }
  return Object.values(record).some(namesMediaUrl);
}
