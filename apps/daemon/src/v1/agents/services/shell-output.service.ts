import { closeSync, fstatSync, openSync, readSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';

import { Injectable } from '@nestjs/common';
import { BadRequestException, NotFoundException } from '@packages/common';

import type { Item } from '../../runs/entity/item.entity';
import { MAX_SHELL_OUTPUT_BYTES, type ShellOutputWire } from '../chat.types';
import { ItemDao } from '../dao/item.dao';
import { RunDao } from '../dao/run.dao';

/**
 * What one shell command an agent started has WRITTEN — the terminal behind a
 * row in the running-shells list.
 *
 * The panel lists what is running; this is what opens when the user asks to see
 * one. Two sources, decided by what the command actually is rather than by a
 * flag from the caller:
 *
 * - a DETACHED command's output is a file the CLI is still appending to, so it
 *   is tailed here and can be re-read while the command runs;
 * - a FOREGROUND command's output IS its tool result, already in the
 *   transcript, and is echoed back so one route answers for both and the panel
 *   needs no second path.
 *
 * **The caller never supplies a path.** It names a tool call of a run it is
 * already authorized for, and the file is whatever THAT call's own reply
 * announced — so this is not a file-read channel with a validated argument, it
 * is a read of the one file the CLI itself named in this run's transcript. The
 * checks below (absolute, a real regular file, a bounded tail) are what keep it
 * that way if the prose it is parsed from ever changes shape.
 */
@Injectable()
export class ShellOutputService {
  constructor(
    private readonly runs: RunDao,
    private readonly items: ItemDao,
  ) {}

  /**
   * Read one command's output.
   *
   * Absent output is an ANSWER (`unavailableReason`), never an error: a command
   * still running in the foreground has produced nothing readable yet, and a
   * CLI that keeps no output file has none to give. Only a request that names
   * nothing real — an unknown run, a call this run never made — is refused.
   */
  async read(runId: string, callId: string): Promise<ShellOutputWire> {
    const id = callId.trim();
    // Validated for SHAPE before it reaches the DAO's `$like`, where a `%` or
    // an `_` would otherwise be a wildcard over every payload in the run. Both
    // CLIs' ids are opaque tokens (`toolu_01…`, a uuid), so this refuses
    // nothing real.
    if (id === '' || !/^[A-Za-z0-9_-]{1,200}$/.test(id)) {
      throw new BadRequestException(
        'SHELL_CALL_ID_INVALID',
        'that is not a tool call id',
      );
    }
    if ((await this.runs.getById(runId)) === null) {
      throw new NotFoundException('RUN_NOT_FOUND', `run ${runId} not found`);
    }
    const { call, result } = await this.items.findToolCallPair(runId, id);
    if (call === null) {
      throw new NotFoundException(
        'SHELL_CALL_NOT_FOUND',
        `this run made no tool call ${id}`,
      );
    }
    if (result === null) {
      return {
        text: '',
        truncated: false,
        unavailableReason:
          'still running — this command’s output arrives when it finishes',
      };
    }
    const replyText = resultText(result);
    const path = outputPathOf(replyText);
    if (path === null) {
      // The reply IS the output: a foreground command's whole stdout/stderr
      // comes back in its tool result, which is the transcript row beside it.
      return { text: replyText, truncated: false, unavailableReason: null };
    }
    return readTail(path);
  }
}

/**
 * A tool result's content as one string — the CLI's own reply text.
 *
 * `Item.payload` is JSON TEXT (the column is `text`; only the wire projection
 * parses it), so this parses before reading. Getting that wrong is silent: every
 * read off the string is `undefined` and the route answers as though the command
 * had produced nothing.
 */
function resultText(item: Item): string {
  let payload: unknown;
  try {
    payload = JSON.parse(item.payload);
  } catch {
    return '';
  }
  const value =
    payload !== null && typeof payload === 'object'
      ? (payload as { result?: unknown }).result
      : null;
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    // A content-block array, collapsed to its texts — the same reading the
    // renderer's `toolResultText` makes of the same payload.
    return value
      .map((block) =>
        block !== null && typeof block === 'object' && 'text' in block
          ? String((block as { text: unknown }).text)
          : '',
      )
      .join('\n');
  }
  return value === null || value === undefined ? '' : JSON.stringify(value);
}

/**
 * The file a detached command is writing to, out of the reply that announced it.
 *
 * TWIN PARSER: `apps/ui/src/renderer/chats/shell-activity.ts` reads the ID out
 * of this same sentence, to know which shell a later probe is about. Both are
 * readings of one CLI's PROSE — claude answers a backgrounded command with
 * `Command running in background with ID: <id>. Output is being written to:
 * <path>.` (read out of the installed 2.1.237 binary's own string table) — so
 * neither side has a schema to lean on and a wording change breaks both.
 *
 * Anchored on the label and stopped at the sentence's own full stop. A miss is
 * survivable everywhere it is used: here it means the reply is treated as the
 * output itself, which is exactly right for the foreground case that carries no
 * such sentence.
 */
function outputPathOf(text: string): string | null {
  const match = /Output is being written to:\s*(\S+?)\.?(?:\s|$)/.exec(text);
  const path = match?.[1];
  // Absolute only. A relative path would have to be resolved against something,
  // and the only candidate — the run's cwd — is not where the CLI writes these;
  // guessing would turn a parse miss into a read of an unrelated file.
  return path !== undefined && isAbsolute(path) ? path : null;
}

/** The last {@link MAX_SHELL_OUTPUT_BYTES} of a file, decoded as UTF-8. */
function readTail(path: string): ShellOutputWire {
  let stats;
  try {
    stats = statSync(path);
  } catch {
    return {
      text: '',
      truncated: false,
      unavailableReason:
        'the output file is gone — the CLI removes it once the command is reaped',
    };
  }
  if (!stats.isFile()) {
    return {
      text: '',
      truncated: false,
      unavailableReason: 'the output path is not a file',
    };
  }
  const fd = openSync(path, 'r');
  try {
    // Re-stat through the OPEN handle: the command is still appending, so the
    // size read a moment ago can already be wrong, and reading past the end
    // returns fewer bytes than asked for.
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - MAX_SHELL_OUTPUT_BYTES);
    const length = size - start;
    if (length === 0) {
      return {
        text: '',
        truncated: false,
        unavailableReason:
          'this command has written nothing to its output file yet',
      };
    }
    const buffer = Buffer.alloc(length);
    const read = readSync(fd, buffer, 0, length, start);
    const text = buffer.subarray(0, read).toString('utf8');
    if (start === 0) {
      return { text, truncated: false, unavailableReason: null };
    }
    // The tail starts mid-line, and mid-CHARACTER: a cut inside a multi-byte
    // sequence decodes to a replacement glyph. Dropping to the first newline
    // fixes both at once, and losing one partial line off a 256KB tail costs
    // nothing.
    const newline = text.indexOf('\n');
    return {
      text: newline === -1 ? text : text.slice(newline + 1),
      truncated: true,
      unavailableReason: null,
    };
  } finally {
    closeSync(fd);
  }
}
