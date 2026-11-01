import { z } from 'zod';

export const STORAGE_GROUP_IDS = [
  'database',
  'chatFiles',
  'agentSessions',
  'taskFiles',
  'teams',
  'teamBackups',
  'logs',
  'caches',
  'appState',
  'leftovers',
  'settingsCopies',
] as const;
export type StorageGroupId = (typeof STORAGE_GROUP_IDS)[number];

export const STORAGE_CLEAN_TARGETS = [
  'archivedChats',
  'compactDatabase',
  'orphanChatFiles',
  'orphanTaskFiles',
  'teamBackups',
  'logs',
  'leftovers',
  'settingsCopies',
] as const;
export type StorageCleanTarget = (typeof STORAGE_CLEAN_TARGETS)[number];

export const StorageCleanTargetSchema = z
  .enum(STORAGE_CLEAN_TARGETS)
  .meta({ id: 'StorageCleanTarget' });

export const StorageEntrySchema = z
  .object({
    name: z.string().describe('The path under the data folder'),
    bytes: z.number().int().describe('Space it takes on disk'),
  })
  .meta({ id: 'StorageEntry' });
export type StorageEntry = z.infer<typeof StorageEntrySchema>;

export const StorageCleanOptionSchema = z
  .object({
    target: StorageCleanTargetSchema,
    count: z
      .number()
      .int()
      .describe('How many chats, files or folders it removes'),
    bytes: z
      .number()
      .int()
      .nullable()
      .describe(
        'The space it frees — null when that is only known once the database is compacted',
      ),
  })
  .meta({ id: 'StorageCleanOption' });
export type StorageCleanOption = z.infer<typeof StorageCleanOptionSchema>;

export const StorageGroupSchema = z
  .object({
    id: z.enum(STORAGE_GROUP_IDS),
    bytes: z.number().int(),
    entries: z.array(StorageEntrySchema),
    clean: z.array(StorageCleanOptionSchema),
  })
  .meta({ id: 'StorageGroup' });
export type StorageGroup = z.infer<typeof StorageGroupSchema>;

export const STORAGE_JOB_STATES = [
  'scheduled',
  'running',
  'done',
  'failed',
] as const;

export const StorageJobSchema = z
  .object({
    target: StorageCleanTargetSchema,
    state: z.enum(STORAGE_JOB_STATES),
    startedAt: z.string(),
    finishedAt: z.string().nullable(),
    removed: z.number().int(),
    freedBytes: z.number().int().nullable(),
    error: z.string().nullable(),
  })
  .meta({ id: 'StorageJob' });
export type StorageJob = z.infer<typeof StorageJobSchema>;

export const StorageUsageSchema = z.object({
  root: z.string().describe('The data folder every entry is under'),
  scannedAt: z.string(),
  groups: z.array(StorageGroupSchema),
  chats: z.object({
    active: z.number().int(),
    archived: z.number().int(),
  }),
  unclaimed: z
    .array(z.string())
    .describe(
      "Top-level names the daemon does not own — the desktop app's own files, measured by Electron main",
    ),
  job: StorageJobSchema.nullable(),
});
export type StorageUsage = z.infer<typeof StorageUsageSchema>;

export const StorageJobReadSchema = z.object({
  job: StorageJobSchema.nullable(),
});

export const StorageCleanRequestSchema = z.object({
  target: StorageCleanTargetSchema,
});

/**
 * The inodes one scan has already counted, shared across every path it
 * measures so a hard-linked file is counted once, as `du` counts it.
 */
export type SeenInodes = Set<string>;

/** Which group a top-level name of the data folder is shown in, or null. */
export type StorageClassifier = (name: string) => StorageGroupId | null;
