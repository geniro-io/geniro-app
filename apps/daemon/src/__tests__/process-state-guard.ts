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

type Shape = Map<PropertyKey, PropertyDescriptor>;
type Graph = Map<object, { path: string; shape: Shape }>;

// `{ spy: true }` also spies in place on every class the module exports, down
// to methods it copies onto their prototypes, so the graph is walked, not just
// the exports, and through the module's getters that load a class lazily
// (`fs.ReadStream`). Other getters are left unread: some warn as deprecated.
const GRAPH_DEPTH = 4;
const LAZY_CLASS = /^[A-Z][a-z]/;

const isObjectLike = (value: unknown): value is object =>
  (typeof value === 'object' && value !== null) || typeof value === 'function';

const ownShape = (target: object): Shape =>
  new Map(
    Reflect.ownKeys(target).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(target, key) as PropertyDescriptor,
    ]),
  );

const moduleGraph = (name: string): Graph => {
  const graph: Graph = new Map();
  const walk = (target: object, path: string, depth: number): void => {
    if (graph.has(target)) {
      return;
    }
    const shape = ownShape(target);
    graph.set(target, { path, shape });
    if (depth === GRAPH_DEPTH) {
      return;
    }
    for (const [key, descriptor] of shape) {
      const value: unknown =
        depth === 0 && descriptor.get && LAZY_CLASS.test(String(key))
          ? Reflect.get(target, key)
          : descriptor.value;
      if (isObjectLike(value)) {
        const segment = String(key);
        walk(value, path ? `${path}.${segment}` : segment, depth + 1);
      }
    }
  };
  walk(process.getBuiltinModule(name) as object, '', 0);
  return graph;
};

const restoreMocks = (graph: Graph): string[] => {
  const restored: string[] = [];
  for (const [target, { path, shape }] of graph) {
    for (const key of Reflect.ownKeys(target)) {
      const current = Object.getOwnPropertyDescriptor(target, key);
      if (!vi.isMockFunction(current?.value)) {
        continue;
      }
      const original = shape.get(key);
      if (original?.value === current?.value) {
        continue;
      }
      if (original) {
        Object.defineProperty(target, key, original);
      } else {
        Reflect.deleteProperty(target, key);
      }
      restored.push(path ? `${path}.${String(key)}` : String(key));
    }
  }
  return restored;
};

export const watchProcessState = (): (() => string[]) => {
  const envAtStart = { ...process.env };
  const cwdAtStart = process.cwd();
  const builtinsAtStart = WATCHED_BUILTINS.map(
    (name) => [name, moduleGraph(name)] as const,
  );

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
    for (const [name, graph] of builtinsAtStart) {
      const patched = restoreMocks(graph);
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
