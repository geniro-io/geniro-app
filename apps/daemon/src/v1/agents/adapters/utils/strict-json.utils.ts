import { readFile } from 'node:fs/promises';

import { asRecord } from '../../utils/json-util';

/**
 * A CLI's own config file, read before geniro rewrites it — the opposite of
 * `fs-safe.utils.ts`, which reads for a LABEL and so treats every failure as
 * empty. A write cannot: an unreadable or unparseable file treated as empty
 * would be replaced by one holding geniro's edit alone, taking every setting
 * the user had with it. Refusing costs one action; guessing costs their config.
 *
 * A MISSING file is the one failure that reads as empty — there is nothing in
 * it to lose, and the write is what creates it.
 *
 * In `adapters/utils/` because it names no CLI: claude's MCP toggle and
 * cursor's plugin copy both rewrite a file the CLI owns, and two readers is how
 * one of them comes to accept a file the other refuses.
 */
export type ConfigRead =
  { ok: true; config: Record<string, unknown> } | { ok: false; reason: string };

export async function readConfigForRewrite(file: string): Promise<ConfigRead> {
  let source: string;
  try {
    source = await readFile(file, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return { ok: true, config: {} };
    }
    return {
      ok: false,
      reason: `${file} could not be read (${code ?? 'unknown error'}), so geniro will not rewrite it`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return {
      ok: false,
      reason: `${file} is not valid JSON, so geniro will not rewrite it`,
    };
  }
  const config = asRecord(parsed);
  return config === null
    ? {
        ok: false,
        reason: `${file} is not a JSON object, so geniro will not rewrite it`,
      }
    : { ok: true, config };
}
