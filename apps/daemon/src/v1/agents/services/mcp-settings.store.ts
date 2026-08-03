import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { Injectable, Logger } from '@nestjs/common';

import { environment } from '../../../environments';
import { atomicWrite } from '../../../utils/atomic-file';
import type { AgentKind } from '../../runs/runs.types';

/**
 * Defensive bound per key. A folder with more disabled servers than this has
 * something wrong with it, and an unbounded list is a file that grows forever
 * on a caller that toggles in a loop.
 */
const MAX_DISABLED_PER_KEY = 200;

/**
 * The store key. Both dimensions matter: one folder is routinely used by both
 * CLIs and their server sets have nothing to do with each other, and the same
 * agent sees different servers in different folders.
 *
 * NUL-joined because it is the one byte a path cannot contain — the same key
 * shape `SkillHarvestStore` and `AgentMcpService` use.
 */
function keyOf(agent: AgentKind, cwd: string): string {
  return `${agent}\u0000${cwd}`;
}

/** Constructor options — a test seam, not user config. */
export interface McpSettingsStoreOptions {
  /** The store file; defaults to `<userData>/mcp-settings.json`. */
  file?: string;
}

/**
 * Which MCP servers the user has switched OFF, per agent and folder.
 *
 * This is geniro's own file and the only one this feature writes — the user's
 * `~/.claude.json`, `.claude/settings*.json` and project `.mcp.json` are read
 * at most, never written. It holds geniro's neutral vocabulary (a set of
 * server names), NOT any CLI's settings shape: translating that set into the
 * flags and keys a particular CLI understands belongs to that CLI's adapter,
 * so a second agent with a different mechanism needs no change here.
 *
 * Writes are atomic (tmp + rename), because this file is read on every turn:
 * a half-written one would be a malformed settings file handed to the CLI.
 * A file that is missing or unparseable degrades to "nothing is disabled"
 * rather than failing a turn — losing a toggle is recoverable, refusing to
 * run is not.
 */
@Injectable()
export class McpSettingsStore {
  private readonly logger = new Logger(McpSettingsStore.name);
  private readonly file: string;
  private records: Map<string, string[]> | null = null;

  constructor(options: McpSettingsStoreOptions = {}) {
    this.file =
      options.file ?? join(environment.userDataDir, 'mcp-settings.json');
  }

  /**
   * The server names this agent has switched off in this folder. Empty when
   * none are, which is also what an unreadable store reports.
   *
   * SYNCHRONOUS on purpose. It is read while a turn's argv is being built, and
   * that builder is synchronous — an async read there would either restructure
   * the graph executor's walk around one tiny file or push the read off the
   * turn entirely. The file is a few hundred bytes and is parsed once per
   * daemon launch; `SkillHarvestStore` reads its cache the same way for the
   * same reason.
   */
  disabled(agent: AgentKind, cwd: string): readonly string[] {
    return this.load().get(keyOf(agent, cwd)) ?? [];
  }

  /**
   * Switch one server on or off. Returns the resulting disabled set for that
   * key so a caller can answer with the state that actually landed rather
   * than the one it asked for.
   */
  async setDisabled(
    agent: AgentKind,
    cwd: string,
    server: string,
    disabled: boolean,
  ): Promise<readonly string[]> {
    const records = this.load();
    const key = keyOf(agent, cwd);
    const current = records.get(key) ?? [];
    const next = disabled
      ? current.includes(server)
        ? current
        : [...current, server].slice(0, MAX_DISABLED_PER_KEY)
      : current.filter((name) => name !== server);
    if (next.length === 0) {
      records.delete(key);
    } else {
      records.set(key, next);
    }
    await this.save(records);
    return next;
  }

  private load(): Map<string, string[]> {
    if (this.records !== null) {
      return this.records;
    }
    const records = new Map<string, string[]>();
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
      if (typeof parsed === 'object' && parsed !== null) {
        for (const [key, value] of Object.entries(parsed)) {
          // Validate per entry rather than per file: one corrupted key must
          // not discard every other folder's toggles.
          if (
            Array.isArray(value) &&
            value.every((entry) => typeof entry === 'string')
          ) {
            records.set(key, value.slice(0, MAX_DISABLED_PER_KEY));
          }
        }
      }
    } catch {
      // Missing or malformed — nothing is disabled. The next write replaces
      // the file wholesale, so a corrupt one repairs itself on the next
      // toggle rather than needing a migration.
    }
    this.records = records;
    return records;
  }

  private async save(records: Map<string, string[]>): Promise<void> {
    // The in-memory map is updated before the write, so a disk failure leaves
    // this daemon serving the toggle the user just made while warning that it
    // will not survive a restart.
    this.records = records;
    try {
      await mkdir(dirname(this.file), { recursive: true });
      await atomicWrite(
        this.file,
        JSON.stringify(Object.fromEntries(records), null, 2),
      );
    } catch (err) {
      this.logger.warn(
        `MCP settings write failed (this session only, lost on restart): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
