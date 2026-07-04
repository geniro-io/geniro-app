/**
 * Defensively read a string field from a WS message payload that may arrive as
 * the bare string OR as `{ [key]: string }`. Shared by the Socket.IO gateways
 * (notifications' `runId`, terminals' `terminalId`) so the one parser is
 * extracted, not mirrored. Returns null for anything else (missing, empty,
 * wrong type).
 */
export function extractStringField(data: unknown, key: string): string | null {
  if (typeof data === 'string') {
    return data.length > 0 ? data : null;
  }
  if (data && typeof data === 'object' && key in data) {
    const value = (data as Record<string, unknown>)[key];
    return typeof value === 'string' && value.length > 0 ? value : null;
  }
  return null;
}
