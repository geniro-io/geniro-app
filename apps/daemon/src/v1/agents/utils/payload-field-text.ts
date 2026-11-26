import { redactSecrets } from '../../diagnostics/utils/redact';
import { collapseImageBlocks } from './collapse-image-blocks';
import { asRecord } from './json-util';

/**
 * One field of a row's payload as text, images collapsed and secrets masked
 * before any cut; the whole payload's text when the payload is not JSON, and
 * nothing when the field is absent.
 */
export function payloadFieldText(payload: string, field: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return redactSecrets(payload);
  }
  const record = asRecord(parsed);
  if (record === null || record[field] === undefined) {
    return '';
  }
  const value = collapseImageBlocks(record[field]);
  return redactSecrets(
    typeof value === 'string' ? value : JSON.stringify(value),
  );
}

/**
 * A tool result's text. A result some CLIs record as a list of content
 * blocks is read as the text its blocks carry, not as their JSON.
 */
export function toolResultText(payload: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return redactSecrets(payload);
  }
  const result = asRecord(parsed)?.result;
  if (Array.isArray(result)) {
    const texts = result.flatMap((block) => {
      const record = asRecord(block);
      return record?.type === 'text' && typeof record.text === 'string'
        ? [record.text]
        : [];
    });
    if (texts.length > 0) {
      return redactSecrets(texts.join('\n'));
    }
  }
  return payloadFieldText(payload, 'result');
}
