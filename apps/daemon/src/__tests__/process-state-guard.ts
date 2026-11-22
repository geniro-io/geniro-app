import { vi } from 'vitest';

// `vi.mock(<built-in>, { spy: true })` patches the process-wide module object
// itself, which outlives the file, unlike a factory mock.
const WATCHED_BUILTINS = [
  'node:fs',
  'node:fs/promises',
  'node:child_process',
  'node:os',
  'node:crypto',
  'node:timers/promises',
] as const;

// Written by a library on every use, not by a spec: MikroORM's `Configuration`
// sets this one each time an ORM is created.
const LIBRARY_ENV_KEYS = new Set(['MIKRO_ORM_COLORS']);

type Exports = Record<string, unknown>;

const builtinExports = (): Map<string, Exports> =>
  new Map(
    WATCHED_BUILTINS.map((name) => [
      name,
      { ...(process.getBuiltinModule(name) as Exports) },
    ]),
  );

export const watchProcessState = (): (() => string[]) => {
  const envAtStart = { ...process.env };
  const cwdAtStart = process.cwd();
  const builtinsAtStart = builtinExports();

  return () => {
    const leaks: string[] = [];
    if (vi.isFakeTimers()) {
      vi.useRealTimers();
      leaks.push('fake timers were left on');
    }
    const cwd = process.cwd();
    if (cwd !== cwdAtStart) {
      process.chdir(cwdAtStart);
      leaks.push(`cwd was left at ${cwd}`);
    }
    const changedEnv = [
      ...new Set([...Object.keys(envAtStart), ...Object.keys(process.env)]),
    ].filter(
      (key) =>
        !LIBRARY_ENV_KEYS.has(key) && process.env[key] !== envAtStart[key],
    );
    for (const key of changedEnv) {
      const value = envAtStart[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    if (changedEnv.length > 0) {
      leaks.push(`process.env was left changed: ${changedEnv.join(', ')}`);
    }
    for (const [name, atStart] of builtinsAtStart) {
      const module = process.getBuiltinModule(name) as Exports;
      const patched = Object.keys(atStart).filter(
        (key) => module[key] !== atStart[key] && vi.isMockFunction(module[key]),
      );
      for (const key of patched) {
        module[key] = atStart[key];
      }
      if (patched.length > 0) {
        const shown = patched.slice(0, 5).join(', ');
        const more =
          patched.length > 5 ? ` and ${patched.length - 5} more` : '';
        leaks.push(
          `${name} was left patched: ${shown}${more} (mock a built-in with a factory, never { spy: true })`,
        );
      }
    }
    return leaks;
  };
};
