import { MAX_UI_COMPONENTS, MAX_UI_SURFACE_BYTES } from '../../chat.types';
import {
  type A2uiComponent,
  a2uiError,
  type A2uiMessage,
} from './a2ui-validate';

export interface SurfaceSnapshot {
  components: A2uiComponent[];
  dataModel: Record<string, unknown>;
}

export interface SurfaceApplied {
  snapshot: SurfaceSnapshot;
  created: boolean;
  removed: boolean;
  writes: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function pointerSegments(pointer: string): string[] {
  if (pointer === '' || pointer === '/') {
    return [];
  }
  return pointer
    .split('/')
    .slice(1)
    .map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'));
}

export function pointerGet(root: unknown, pointer: string): unknown {
  let node = root;
  for (const key of pointerSegments(pointer)) {
    if (Array.isArray(node)) {
      node = node[Number(key)];
    } else if (isRecord(node)) {
      node = node[key];
    } else {
      return undefined;
    }
  }
  return node;
}

function setIn(node: unknown, keys: string[], value: unknown): unknown {
  const [key, ...rest] = keys;
  if (key === undefined) {
    return value;
  }
  if (Array.isArray(node) && /^\d+$/.test(key)) {
    const copy: unknown[] = [...(node as unknown[])];
    const index = Number(key);
    if (rest.length === 0 && (value === null || value === undefined)) {
      copy.splice(index, 1);
      return copy;
    }
    copy[index] = setIn(copy[index], rest, value);
    return copy;
  }
  const copy: Record<string, unknown> = isRecord(node) ? { ...node } : {};
  if (rest.length === 0 && (value === null || value === undefined)) {
    delete copy[key];
    return copy;
  }
  copy[key] = setIn(copy[key], rest, value);
  return copy;
}

export function pointerSet(
  root: Record<string, unknown>,
  pointer: string,
  value: unknown,
): Record<string, unknown> {
  const keys = pointerSegments(pointer);
  if (keys.length === 0) {
    return isRecord(value) ? value : {};
  }
  const next = setIn(root, keys, value);
  return isRecord(next) ? next : {};
}

export function pointerCovers(outer: string, inner: string): boolean {
  const a = pointerSegments(outer);
  const b = pointerSegments(inner);
  return (
    a.length <= b.length && a.every((segment, index) => segment === b[index])
  );
}

function childRefs(component: A2uiComponent): { at: string; id: string }[] {
  const refs: { at: string; id: string }[] = [];
  const single = (field: string): void => {
    const value = component[field];
    if (typeof value === 'string') {
      refs.push({ at: `/${field}`, id: value });
    }
  };
  const children = component.children;
  if (Array.isArray(children)) {
    children.forEach((id, index) => {
      if (typeof id === 'string') {
        refs.push({ at: `/children/${index}`, id });
      }
    });
  } else if (isRecord(children) && typeof children.componentId === 'string') {
    refs.push({ at: '/children/componentId', id: children.componentId });
  }
  single('child');
  single('trigger');
  single('content');
  if (Array.isArray(component.tabs)) {
    component.tabs.forEach((tab, index) => {
      if (isRecord(tab) && typeof tab.child === 'string') {
        refs.push({ at: `/tabs/${index}/child`, id: tab.child });
      }
    });
  }
  return refs;
}

function checkTree(
  snapshot: SurfaceSnapshot,
  sources: Map<string, string>,
): void {
  const byId = new Map(
    snapshot.components.map((component) => [component.id, component]),
  );
  const where = (id: string): string => sources.get(id) ?? '/messages';
  if (snapshot.components.length > MAX_UI_COMPONENTS) {
    throw a2uiError(
      '/messages',
      `a surface holds at most ${MAX_UI_COMPONENTS} components (this one would hold ${snapshot.components.length})`,
    );
  }
  const bytes = Buffer.byteLength(JSON.stringify(snapshot), 'utf8');
  if (bytes > MAX_UI_SURFACE_BYTES) {
    throw a2uiError(
      '/messages',
      `a surface's components and data model are at most ${MAX_UI_SURFACE_BYTES / 1024} KB (this one would be ${Math.ceil(bytes / 1024)} KB)`,
    );
  }
  if (snapshot.components.length === 0) {
    return;
  }
  if (!byId.has('root')) {
    throw a2uiError(
      '/messages',
      'no component has the id "root", where the surface starts',
    );
  }
  for (const component of snapshot.components) {
    for (const ref of childRefs(component)) {
      if (!byId.has(ref.id)) {
        throw a2uiError(
          `${where(component.id)}${ref.at}`,
          `names "${ref.id}", which no component has as its id`,
        );
      }
    }
  }
  const state = new Map<string, 'open' | 'done'>();
  const visit = (id: string): void => {
    state.set(id, 'open');
    const component = byId.get(id);
    for (const ref of component === undefined ? [] : childRefs(component)) {
      const seen = state.get(ref.id);
      if (seen === 'open') {
        throw a2uiError(
          `${where(id)}${ref.at}`,
          `"${ref.id}" contains "${id}" already, so this makes a cycle`,
        );
      }
      if (seen === undefined) {
        visit(ref.id);
      }
    }
    state.set(id, 'done');
  };
  visit('root');
}

export function applyA2uiMessages(
  prior: SurfaceSnapshot | null,
  priorRemoved: boolean,
  messages: readonly A2uiMessage[],
): SurfaceApplied {
  let snapshot: SurfaceSnapshot | null = prior;
  let created = false;
  let removed = false;
  const writes: string[] = [];
  const sources = new Map<string, string>();
  messages.forEach((message, index) => {
    const at = `/messages/${index}/${message.kind}`;
    if (removed) {
      throw a2uiError(at, 'comes after deleteSurface removed this surface');
    }
    if (message.kind === 'createSurface') {
      if (snapshot !== null || priorRemoved) {
        throw a2uiError(
          `${at}/surfaceId`,
          priorRemoved
            ? `surface "${message.surfaceId}" was removed; draw a new one under a new surfaceId`
            : `surface "${message.surfaceId}" already exists; change it with updateComponents or updateDataModel`,
        );
      }
      created = true;
      snapshot = {
        components: message.components ?? [],
        dataModel: message.dataModel ?? {},
      };
      (message.components ?? []).forEach((component, position) =>
        sources.set(component.id, `${at}/components/${position}`),
      );
      return;
    }
    if (snapshot === null) {
      throw a2uiError(
        `${at}/surfaceId`,
        priorRemoved
          ? `surface "${message.surfaceId}" was removed`
          : `there is no surface "${message.surfaceId}" yet; start it with createSurface`,
      );
    }
    switch (message.kind) {
      case 'updateComponents': {
        const next = [...snapshot.components];
        message.components.forEach((component, position) => {
          const existing = next.findIndex((entry) => entry.id === component.id);
          if (existing === -1) {
            next.push(component);
          } else {
            next[existing] = component;
          }
          sources.set(component.id, `${at}/components/${position}`);
        });
        snapshot = { ...snapshot, components: next };
        return;
      }
      case 'updateDataModel':
        snapshot = {
          ...snapshot,
          dataModel: pointerSet(
            snapshot.dataModel,
            message.path,
            message.value,
          ),
        };
        writes.push(message.path);
        return;
      case 'deleteSurface':
        removed = true;
        return;
    }
  });
  if (snapshot === null) {
    throw a2uiError('/messages', 'draws nothing');
  }
  if (!removed) {
    checkTree(snapshot, sources);
  }
  return { snapshot, created, removed, writes };
}
