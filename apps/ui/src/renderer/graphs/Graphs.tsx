import '@xyflow/react/dist/style.css';

import {
  addEdge,
  Background,
  type Connection,
  Controls,
  type Edge,
  ReactFlow,
  useEdgesState,
  useNodesState,
} from '@xyflow/react';
import {
  Download,
  Plus,
  Trash2,
  Upload,
  Wand2,
  Workflow as WorkflowIcon,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import type {
  DaemonHandle,
  WorkflowApproval,
  WorkflowNode,
  WorkflowSummary,
} from '../../shared/contracts';
import { CLI_KINDS, type CliKind } from '../../shared/contracts';
import { EmptyState } from '../components/empty-state';
import { ErrorText } from '../components/error-text';
import { Field } from '../components/field';
import { NavListItem } from '../components/nav-list-item';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Select } from '../components/ui/select';
import { Textarea } from '../components/ui/textarea';
import { WorkflowApi } from '../workflow-api';
import { AgentNode } from './agent-node';
import {
  type AgentFlowNode,
  autoLayout,
  edgeId,
  fromFlow,
  nextNodeId,
  toFlow,
} from './graph-doc';

const NODE_TYPES = { agent: AgentNode };

/** A fresh single-node draft for the "New workflow" action. */
function draftWorkflow(): { nodes: AgentFlowNode[]; edges: Edge[] } {
  return {
    nodes: [
      {
        id: 'agent-1',
        type: 'agent',
        position: { x: 0, y: 0 },
        data: {
          node: { id: 'agent-1', agent: 'claude', approval: 'auto' },
        },
      },
    ],
    edges: [],
  };
}

/**
 * The Workflows page: compose a DAG of agents on a React Flow canvas, backed
 * by the daemon's YAML library (`*.geniro.yaml` — the source of truth). The
 * canvas is a static builder (no live-run animation in M3); runs start from
 * the Chats page.
 */
export function Graphs({
  handle,
}: {
  handle: DaemonHandle | null;
}): React.JSX.Element {
  const api = useMemo(
    () => (handle ? new WorkflowApi(handle) : null),
    [handle],
  );

  const [summaries, setSummaries] = useState<WorkflowSummary[]>([]);
  const [activeSlug, setActiveSlug] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [nodes, setNodes, onNodesChange] = useNodesState<AgentFlowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [started, setStarted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Seeded once per mount (the page unmounts on every tab switch, so a model
  // saved in Settings is picked up on the next visit).
  const [defaultModel, setDefaultModel] = useState<string | null>(null);
  useEffect(() => {
    void window.geniro
      .getSettings()
      .then((s) => setDefaultModel(s.defaultModel));
  }, []);

  const refreshList = useCallback(async (): Promise<void> => {
    if (!api) {
      return;
    }
    try {
      setSummaries(await api.list());
    } catch (err) {
      setError(String(err));
    }
  }, [api]);

  useEffect(() => {
    void refreshList();
  }, [refreshList]);

  const openWorkflow = useCallback(
    async (slug: string): Promise<void> => {
      if (!api) {
        return;
      }
      setError(null);
      setNotice(null);
      try {
        const { workflow } = await api.get(slug);
        const flow = toFlow(workflow);
        setActiveSlug(slug);
        setName(workflow.name);
        setNodes(flow.nodes);
        setEdges(flow.edges);
        setSelectedNodeId(null);
        setStarted(true);
      } catch (err) {
        setError(String(err));
      }
    },
    [api, setNodes, setEdges],
  );

  const newWorkflow = useCallback((): void => {
    const draft = draftWorkflow();
    setActiveSlug(null);
    setName('New workflow');
    setNodes(draft.nodes);
    setEdges(draft.edges);
    setSelectedNodeId('agent-1');
    setStarted(true);
    setError(null);
    setNotice(null);
  }, [setNodes, setEdges]);

  const save = useCallback(async (): Promise<void> => {
    if (!api) {
      return;
    }
    setError(null);
    try {
      const workflow = fromFlow(
        { name: name.trim() || 'workflow' },
        nodes,
        edges,
      );
      const saved = activeSlug
        ? await api.save(activeSlug, workflow)
        : await api.create(workflow);
      setActiveSlug(saved.slug);
      setNotice(`Saved ${saved.slug}.geniro.yaml`);
      await refreshList();
    } catch (err) {
      setError(String(err));
    }
  }, [api, name, nodes, edges, activeSlug, refreshList]);

  const remove = useCallback(async (): Promise<void> => {
    if (!api || !activeSlug) {
      return;
    }
    setError(null);
    try {
      await api.delete(activeSlug);
      setActiveSlug(null);
      setNodes([]);
      setEdges([]);
      setName('');
      setStarted(false);
      await refreshList();
    } catch (err) {
      setError(String(err));
    }
  }, [api, activeSlug, refreshList, setNodes, setEdges]);

  const importWorkflow = useCallback(async (): Promise<void> => {
    if (!api) {
      return;
    }
    setError(null);
    try {
      const path = await window.geniro.pickWorkflowImport();
      if (!path) {
        return;
      }
      const imported = await api.import(path);
      await refreshList();
      await openWorkflow(imported.slug);
    } catch (err) {
      setError(String(err));
    }
  }, [api, refreshList, openWorkflow]);

  const exportWorkflow = useCallback(async (): Promise<void> => {
    if (!api || !activeSlug) {
      return;
    }
    setError(null);
    try {
      const path = await window.geniro.pickWorkflowExport(
        `${activeSlug}.geniro.yaml`,
      );
      if (!path) {
        return;
      }
      await api.export(activeSlug, path);
      setNotice(`Exported to ${path}`);
    } catch (err) {
      setError(String(err));
    }
  }, [api, activeSlug]);

  const addNode = useCallback((): void => {
    const id = nextNodeId(new Set(nodes.map((n) => n.id)));
    const maxX = nodes.reduce((max, n) => Math.max(max, n.position.x), -260);
    const node: AgentFlowNode = {
      id,
      type: 'agent',
      position: { x: maxX + 260, y: 40 },
      data: {
        node: {
          id,
          agent: 'claude',
          approval: 'auto',
          ...(defaultModel ? { model: defaultModel } : {}),
        },
      },
    };
    setNodes((prev) => [...prev, node]);
    setSelectedNodeId(id);
  }, [nodes, setNodes, defaultModel]);

  const deleteSelected = useCallback((): void => {
    if (!selectedNodeId) {
      return;
    }
    setNodes((prev) => prev.filter((n) => n.id !== selectedNodeId));
    setEdges((prev) =>
      prev.filter(
        (e) => e.source !== selectedNodeId && e.target !== selectedNodeId,
      ),
    );
    setSelectedNodeId(null);
  }, [selectedNodeId, setNodes, setEdges]);

  const layout = useCallback(async (): Promise<void> => {
    try {
      const workflow = fromFlow(
        { name: name.trim() || 'workflow' },
        nodes,
        edges,
      );
      const positions = await autoLayout(workflow);
      setNodes((prev) =>
        prev.map((n) => ({ ...n, position: positions[n.id] ?? n.position })),
      );
    } catch (err) {
      setError(String(err));
    }
  }, [name, nodes, edges, setNodes]);

  const onConnect = useCallback(
    (connection: Connection): void => {
      if (!connection.source || !connection.target) {
        return;
      }
      if (connection.source === connection.target) {
        return; // self-loops are invalid (the daemon rejects them too)
      }
      setEdges((prev) =>
        addEdge(
          { ...connection, id: edgeId(connection.source, connection.target) },
          prev,
        ),
      );
    },
    [setEdges],
  );

  /** Patch the selected node's workflow data (inspector edits). */
  const patchSelected = useCallback(
    (patch: Partial<WorkflowNode>): void => {
      if (!selectedNodeId) {
        return;
      }
      setNodes((prev) =>
        prev.map((n) =>
          n.id === selectedNodeId
            ? { ...n, data: { node: { ...n.data.node, ...patch } } }
            : n,
        ),
      );
    },
    [selectedNodeId, setNodes],
  );

  const selected =
    nodes.find((n) => n.id === selectedNodeId)?.data.node ?? null;

  if (!handle) {
    return <EmptyState>Connecting to the daemon…</EmptyState>;
  }

  return (
    <div className="grid h-full grid-cols-[240px_1fr]">
      <aside className="flex min-h-0 flex-col gap-3 border-r border-border bg-sidebar p-3">
        <div className="flex flex-col gap-2">
          <Button type="button" className="gap-2" onClick={newWorkflow}>
            <Plus className="shrink-0" /> New workflow
          </Button>
          <Button
            type="button"
            variant="outline"
            className="gap-2"
            onClick={() => void importWorkflow()}>
            <Upload className="shrink-0" /> Import YAML…
          </Button>
        </div>
        <ul className="flex min-h-0 flex-1 list-none flex-col gap-1 overflow-y-auto p-0">
          {summaries.length === 0 ? (
            <li className="px-2 py-1.5 text-sm text-muted-foreground">
              No workflows yet
            </li>
          ) : (
            summaries.map((summary) => (
              <NavListItem
                key={summary.slug}
                active={summary.slug === activeSlug}
                title={summary.name}
                subtitle={`${summary.nodeCount} node${summary.nodeCount === 1 ? '' : 's'}`}
                onActivate={() => void openWorkflow(summary.slug)}
              />
            ))
          )}
        </ul>
      </aside>

      <section className="flex min-h-0 flex-col">
        {!started ? (
          <div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center">
            <WorkflowIcon
              aria-hidden="true"
              className="size-10 text-muted-foreground/50"
            />
            <p className="max-w-sm text-sm text-muted-foreground">
              Pick a workflow or create a new one to start composing your agent
              team. Runs start from the Chats page.
            </p>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
              <Input
                value={name}
                aria-label="Workflow name"
                className="w-[220px]"
                onChange={(event) => setName(event.target.value)}
              />
              <Button
                type="button"
                variant="outline"
                className="gap-1.5"
                onClick={addNode}>
                <Plus className="shrink-0" /> Node
              </Button>
              <Button
                type="button"
                variant="outline"
                className="gap-1.5"
                onClick={() => void layout()}>
                <Wand2 className="shrink-0" /> Auto-layout
              </Button>
              <div className="ml-auto flex items-center gap-2">
                {activeSlug ? (
                  <>
                    <Button
                      type="button"
                      variant="outline"
                      className="gap-1.5"
                      onClick={() => void exportWorkflow()}>
                      <Download className="shrink-0" /> Export
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      className="gap-1.5"
                      aria-label="Delete workflow"
                      onClick={() => void remove()}>
                      <Trash2 className="shrink-0" />
                    </Button>
                  </>
                ) : null}
                <Button type="button" onClick={() => void save()}>
                  Save
                </Button>
              </div>
            </div>

            {error ? (
              <ErrorText className="border-b border-border px-3 py-1.5">
                {error}
              </ErrorText>
            ) : null}
            {notice && !error ? (
              <p className="border-b border-border px-3 py-1.5 text-xs text-muted-foreground">
                {notice}
              </p>
            ) : null}

            <div className="grid min-h-0 flex-1 grid-cols-[1fr_260px]">
              <ReactFlow
                nodes={nodes}
                edges={edges}
                nodeTypes={NODE_TYPES}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                onConnect={onConnect}
                onSelectionChange={({ nodes: sel }) =>
                  setSelectedNodeId(sel[0]?.id ?? null)
                }
                fitView
                proOptions={{ hideAttribution: true }}>
                <Background />
                <Controls />
              </ReactFlow>

              <aside className="flex min-h-0 flex-col gap-3 overflow-y-auto border-l border-border p-3">
                {selected ? (
                  <>
                    <Field label="Display name" htmlFor="node-name">
                      <Input
                        id="node-name"
                        value={selected.name ?? ''}
                        placeholder={selected.id}
                        onChange={(event) =>
                          patchSelected({
                            name: event.target.value || undefined,
                          })
                        }
                      />
                    </Field>
                    <Field label="Agent" htmlFor="node-agent">
                      <Select
                        id="node-agent"
                        value={selected.agent}
                        onChange={(event) =>
                          patchSelected({
                            agent: event.target.value as CliKind,
                          })
                        }>
                        {CLI_KINDS.map((kind) => (
                          <option key={kind} value={kind}>
                            {kind}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field
                      label="Model"
                      htmlFor="node-model"
                      hint="Empty = the CLI's default model.">
                      <Input
                        id="node-model"
                        value={selected.model ?? ''}
                        onChange={(event) =>
                          patchSelected({
                            model: event.target.value || undefined,
                          })
                        }
                      />
                    </Field>
                    <Field
                      label="Role / system prompt"
                      htmlFor="node-role"
                      hint="Prepended to this node's turn.">
                      <Textarea
                        id="node-role"
                        value={selected.role ?? ''}
                        rows={5}
                        onChange={(event) =>
                          patchSelected({
                            role: event.target.value || undefined,
                          })
                        }
                      />
                    </Field>
                    <Field
                      label="Tool approvals"
                      htmlFor="node-approval"
                      hint="“Ask in chat” pauses each tool call on an approval card (cursor-agent runs auto regardless).">
                      <Select
                        id="node-approval"
                        value={selected.approval}
                        onChange={(event) =>
                          patchSelected({
                            approval: event.target.value as WorkflowApproval,
                          })
                        }>
                        <option value="auto">auto-approve</option>
                        <option value="ask">ask in chat</option>
                      </Select>
                    </Field>
                    <Button
                      type="button"
                      variant="outline"
                      className="gap-1.5"
                      onClick={deleteSelected}>
                      <Trash2 className="shrink-0" /> Delete node
                    </Button>
                  </>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Select a node to edit it. Drag from a node's right edge to
                    another node's left edge to feed its final answer forward.
                  </p>
                )}
              </aside>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
