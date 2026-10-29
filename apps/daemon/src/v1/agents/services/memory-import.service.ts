import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { setImmediate } from 'node:timers/promises';

import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';

import {
  MEMORY_TYPES,
  memoryHandle,
  type MemoryImportPreview,
  type MemoryImportPreviewRequest,
  type MemoryImportRequest,
  type MemoryImportResult,
  type MemoryImportRow,
  type MemoryType,
} from '../../memory/memory.types';
import { MemoryService } from '../../memory/services/memory.service';
import { importedText } from '../../memory/utils/memory-text';
import { ProjectDao } from '../../projects/dao/project.dao';
import type { AgentKind } from '../../runs/runs.types';
import type { NativeMemoryNote } from '../adapters/adapter.types';
import { AgentAdapterRegistry } from './agent-adapter.registry';

/** Notes checked against the stored entries between two yields of the loop. */
const PREVIEW_WINDOW = 20;

interface SourcedNote extends NativeMemoryNote {
  key: string;
  agentKind: AgentKind;
  /** Title and body together, so the same note read twice is known as one. */
  textHash: string;
}

/**
 * The one-time import of each CLI's own memory into the shared one: a preview
 * of every note, then a write of the notes the user ticked. Every CLI fact —
 * where its notes live, how it files them by project — is its adapter's
 * (`readNativeMemory`, `nativeMemoryProjectKey`); this service only files
 * them. Nothing here writes, moves or deletes a CLI's file.
 */
@Injectable()
export class MemoryImportService {
  constructor(
    private readonly em: EntityManager,
    private readonly adapters: AgentAdapterRegistry,
    private readonly memory: MemoryService,
    private readonly projects: ProjectDao,
  ) {}

  async preview(
    request: MemoryImportPreviewRequest,
  ): Promise<MemoryImportPreview> {
    const { notes, sources } = await this.read(request.profiles);
    const projectsOf = await this.projectsByKey();
    const imported = await this.memory.importedTexts();
    const firstWithText = new Map<string, string>();
    const rows: MemoryImportRow[] = [];
    for (const [n, note] of notes.entries()) {
      if (n > 0 && n % PREVIEW_WINDOW === 0) {
        await setImmediate();
      }
      const claimed =
        note.projectKey === null
          ? []
          : (projectsOf.get(`${note.agentKind}\n${note.projectKey}`) ?? []);
      const projectId = claimed.length === 1 ? claimed[0]! : null;
      const sameAs = firstWithText.get(note.textHash) ?? null;
      if (sameAs === null) {
        firstWithText.set(note.textHash, note.key);
      }
      rows.push({
        key: note.key,
        agentKind: note.agentKind,
        sourcePath: note.path,
        title: note.title,
        body: note.body,
        type: typeOf(note.type, projectId),
        projectId,
        projectMatch:
          claimed.length === 1
            ? 'matched'
            : claimed.length > 1
              ? 'ambiguous'
              : 'none',
        similarTo: (await this.memory.similarTo(note.title, projectId)).map(
          (row) => ({
            handle: memoryHandle(row.handle),
            title: row.title,
            status: row.status,
          }),
        ),
        sameAs,
        alreadyImported: imported.has(importedText(note.title, note.body)),
        problem: this.memory.problemOf(note),
      });
    }
    return { rows, sources };
  }

  /**
   * Write the ticked rows. Each key names a note's text as the preview showed
   * it, so a note edited since, or one the CLI rewrote, is skipped rather than
   * stored unseen; a key ticked twice, or a second copy of one note, is
   * written once.
   */
  async apply(request: MemoryImportRequest): Promise<MemoryImportResult> {
    const { notes } = await this.read(request.profiles);
    const byKey = new Map(notes.map((note) => [note.key, note]));
    const skipped: MemoryImportResult['skipped'] = [];
    const seenKeys = new Set<string>();
    const seenTexts = new Set<string>();
    const ticked = request.rows.flatMap((row) => {
      if (seenKeys.has(row.key)) {
        return [];
      }
      seenKeys.add(row.key);
      const note = byKey.get(row.key);
      if (!note) {
        skipped.push({
          key: row.key,
          reason: 'the note changed or is gone since the preview',
        });
        return [];
      }
      if (seenTexts.has(note.textHash)) {
        skipped.push({
          key: row.key,
          reason: 'the same note is already in this import',
        });
        return [];
      }
      seenTexts.add(note.textHash);
      return [
        {
          key: row.key,
          title: note.title,
          body: note.body,
          type: row.type,
          projectId: row.projectId,
          importedFrom: note.importedFrom,
        },
      ];
    });
    const result = await this.memory.importNotes(ticked);
    return { ...result, skipped: [...skipped, ...result.skipped] };
  }

  private async read(profiles: MemoryImportRequest['profiles']): Promise<{
    notes: SourcedNote[];
    sources: MemoryImportPreview['sources'];
  }> {
    const notes: SourcedNote[] = [];
    const sources: MemoryImportPreview['sources'] = [];
    const seenKeys = new Set<string>();
    for (const [agentKind, adapter] of this.adapters.all()) {
      const dirs = [
        null,
        ...new Set(
          profiles
            .filter((profile) => profile.agentKind === agentKind)
            .map((profile) => resolve(profile.dir)),
        ),
      ];
      const locations = new Set<string>();
      for (const dir of dirs) {
        const reading = await adapter.readNativeMemory(dir);
        if (reading === null || locations.has(reading.location)) {
          continue;
        }
        locations.add(reading.location);
        sources.push({
          agentKind,
          path: reading.location,
          found: reading.notes.length,
        });
        for (const note of reading.notes) {
          const textHash = hashOf(`${note.title}\u0000${note.body}`);
          const key = `${agentKind}:${note.importedFrom}#${textHash}`;
          if (seenKeys.has(key)) {
            continue;
          }
          seenKeys.add(key);
          notes.push({ ...note, key, agentKind, textHash });
        }
      }
    }
    return { notes, sources };
  }

  /**
   * Each live project under the key every CLI files its folder's notes under.
   * A CLI's key can be lossy, so one key may stand for several projects.
   */
  private async projectsByKey(): Promise<Map<string, string[]>> {
    const byKey = new Map<string, string[]>();
    const projects = await this.projects.getAll({}, undefined, this.em.fork());
    for (const [agentKind, adapter] of this.adapters.all()) {
      for (const project of projects) {
        const projectKey = adapter.nativeMemoryProjectKey(project.folder);
        if (projectKey === null) {
          continue;
        }
        const key = `${agentKind}\n${projectKey}`;
        byKey.set(key, [...(byKey.get(key) ?? []), project.id]);
      }
    }
    return byKey;
  }
}

function hashOf(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function typeOf(cliType: string | null, projectId: string | null): MemoryType {
  const known = MEMORY_TYPES.find((type) => type === cliType?.toLowerCase());
  return known ?? (projectId === null ? 'reference' : 'project');
}
