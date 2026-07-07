import { BadRequestException } from '@packages/common';
import { Document, isMap, isSeq, parseDocument, type YAMLMap } from 'yaml';

import {
  type Workflow,
  type WorkflowEdge,
  type WorkflowNode,
  WorkflowSchema,
} from '../graphs.types';

/**
 * YAML (de)serialization for `*.geniro.yaml` workflow files. Serialization is
 * comment-preserving: when the existing file source is supplied, the parsed
 * Document is mutated in place — scalar keys are updated, node/edge entries
 * are matched to their existing YAML items (by node id / edge endpoints) and
 * patched field-by-field — so comments and formatting the user wrote by hand
 * survive a canvas save. A full re-dump (which would erase them) happens only
 * for brand-new files or when the existing source is unparseable.
 */

/** Parse + zod-validate one workflow file's source. */
export function parseWorkflowYaml(source: string): Workflow {
  const doc = parseDocument(source);
  if (doc.errors.length > 0) {
    throw new BadRequestException(
      'WORKFLOW_YAML_INVALID',
      `YAML parse error: ${doc.errors[0]!.message}`,
    );
  }
  const parsed = WorkflowSchema.safeParse(doc.toJS());
  if (!parsed.success) {
    const summary = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new BadRequestException('WORKFLOW_YAML_INVALID', summary);
  }
  return parsed.data;
}

/** A workflow as a plain-JS tree with undefined-valued keys pruned. */
function workflowToPlain(workflow: Workflow): Record<string, unknown> {
  return JSON.parse(JSON.stringify(workflow)) as Record<string, unknown>;
}

/** Set `key` on a YAML map, or drop the key entirely when value is undefined. */
function setOrDelete(map: YAMLMap, key: string, value: unknown): void {
  if (value === undefined) {
    map.delete(key);
  } else {
    map.set(key, value);
  }
}

const AGENT_ONLY_FIELDS = ['agent', 'model', 'role', 'approval'] as const;
const TRIGGER_ONLY_FIELDS = ['trigger'] as const;

function patchNodeItem(item: YAMLMap, node: WorkflowNode): void {
  item.set('kind', node.kind);
  setOrDelete(item, 'name', node.name);
  // Patch this kind's fields and drop the other kind's — a hand-edited file
  // that flipped a node's kind must not keep stale cross-kind keys.
  if (node.kind === 'agent') {
    for (const field of TRIGGER_ONLY_FIELDS) {
      setOrDelete(item, field, undefined);
    }
    for (const field of AGENT_ONLY_FIELDS) {
      setOrDelete(item, field, node[field]);
    }
  } else {
    for (const field of AGENT_ONLY_FIELDS) {
      setOrDelete(item, field, undefined);
    }
    for (const field of TRIGGER_ONLY_FIELDS) {
      setOrDelete(item, field, node[field]);
    }
  }
}

function edgeKey(from: unknown, to: unknown, kind: unknown): string {
  // Kind is part of the identity: a data edge and a call edge may share the
  // same from→to pair, and keying them together would drop one on save.
  // JSON keeps the components unambiguous — node ids are free-form and may
  // themselves contain a would-be delimiter like '->' or '#'.
  return JSON.stringify([from, to, kind]);
}

/**
 * Serialize a workflow, merging into `existingSource` when provided so user
 * comments/formatting survive. Returns the YAML text to write to disk.
 */
export function serializeWorkflowYaml(
  workflow: Workflow,
  existingSource?: string | null,
): string {
  if (!existingSource) {
    return new Document(workflowToPlain(workflow)).toString();
  }

  const doc = parseDocument(existingSource);
  if (doc.errors.length > 0 || !isMap(doc.contents)) {
    return new Document(workflowToPlain(workflow)).toString();
  }
  // Widen away Document.Parsed's strict node generics — this function only
  // feeds plain JS values, which the runtime coerces to YAML nodes itself.
  const root = doc.contents as YAMLMap;

  setOrDelete(root, 'name', workflow.name);
  setOrDelete(root, 'description', workflow.description);

  // Nodes: patch retained items in place (file order preserved), drop removed
  // ones, append new ones at the end.
  const keepNodeIds = new Set(workflow.nodes.map((n) => n.id));
  const nodesValue = root.get('nodes');
  if (isSeq(nodesValue)) {
    const patched = new Set<string>();
    // Track ids as they are retained: a hand-edited file can carry the same
    // node id twice, and keeping both would write an invalid graph back out.
    const retained = new Set<string>();
    nodesValue.items = nodesValue.items.filter((item) => {
      if (!isMap(item)) {
        return false;
      }
      const id = item.get('id');
      if (typeof id !== 'string' || !keepNodeIds.has(id) || retained.has(id)) {
        return false;
      }
      retained.add(id);
      return true;
    });
    for (const item of nodesValue.items) {
      const map = item as YAMLMap;
      const id = map.get('id') as string;
      const node = workflow.nodes.find((n) => n.id === id);
      if (node) {
        patchNodeItem(map, node);
        patched.add(id);
      }
    }
    for (const node of workflow.nodes) {
      if (!patched.has(node.id)) {
        nodesValue.add(doc.createNode(JSON.parse(JSON.stringify(node))));
      }
    }
  } else {
    root.set('nodes', doc.createNode(workflowToPlain(workflow).nodes));
  }

  // Edges: same strategy, keyed by from→to→kind. A hand-edited kind-less item
  // never matches a kept key, so it is dropped here and re-appended below
  // with its kind explicit.
  const keepEdges = new Map<string, WorkflowEdge>(
    workflow.edges.map((e) => [edgeKey(e.from, e.to, e.kind), e]),
  );
  const edgesValue = root.get('edges');
  if (isSeq(edgesValue)) {
    const patched = new Set<string>();
    const retained = new Set<string>();
    edgesValue.items = edgesValue.items.filter((item) => {
      if (!isMap(item)) {
        return false;
      }
      const key = edgeKey(item.get('from'), item.get('to'), item.get('kind'));
      if (!keepEdges.has(key) || retained.has(key)) {
        return false;
      }
      retained.add(key);
      return true;
    });
    for (const item of edgesValue.items) {
      const map = item as YAMLMap;
      const key = edgeKey(map.get('from'), map.get('to'), map.get('kind'));
      const edge = keepEdges.get(key);
      if (edge) {
        map.set('kind', edge.kind);
        setOrDelete(map, 'label', edge.label);
        patched.add(key);
      }
    }
    for (const [key, edge] of keepEdges) {
      if (!patched.has(key)) {
        edgesValue.add(doc.createNode(JSON.parse(JSON.stringify(edge))));
      }
    }
  } else {
    root.set('edges', doc.createNode(workflowToPlain(workflow).edges));
  }

  // Layout: canvas-owned positions — replace wholesale (nobody hand-writes
  // pixel coordinates), or drop the block when absent.
  if (workflow.layout === undefined) {
    root.delete('layout');
  } else {
    root.set('layout', doc.createNode(workflow.layout));
  }

  return doc.toString();
}
