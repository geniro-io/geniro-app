import '@xyflow/react/dist/style.css';

import {
  addEdge,
  Background,
  type Connection,
  Controls,
  type Edge,
  PanOnScrollMode,
  ReactFlow,
  type ReactFlowInstance,
  useEdgesState,
  useNodesState,
} from '@xyflow/react';
import {
  ArrowLeft,
  Download,
  Plus,
  Trash2,
  Upload,
  Wand2,
  Workflow as WorkflowIcon,
  Zap,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import type {
  DaemonHandle,
  NodeKind,
  WorkflowAgentNode,
  WorkflowApproval,
  WorkflowNode,
  WorkflowSummary,
  WorkflowTriggerNode,
} from '../../shared/contracts';
import { CLI_KINDS, type CliKind } from '../../shared/contracts';
import { ConfirmButton } from '../components/confirm-button';
import { EmptyState } from '../components/empty-state';
import { ErrorText } from '../components/error-text';
import { Field } from '../components/field';
import { NoteBox } from '../components/note-box';
import { PanelResizeHandle, usePanelWidth } from '../components/panel-resize';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Select } from '../components/ui/select';
import { Textarea } from '../components/ui/textarea';
import { WorkflowApi } from '../workflow-api';
import { AgentAvatar } from './agent-avatar';
import { AgentNode } from './agent-node';
import { CreateWorkflowDialog } from './create-workflow-dialog';
import {
  autoLayout,
  edgeId,
  fromFlow,
  type GraphFlowNode,
  nextNodeId,
  toFlow,
} from './graph-doc';
import {
  NODE_DND_MIME,
  NodePalette,
  type PaletteItem,
  parsePaletteItem,
} from './node-palette';
import { canConnect, makeHandleId } from './node-schema';
import { TriggerNode } from './trigger-node';
import { WorkflowCard } from './workflow-card';

const NODE_TYPES = { agent: AgentNode, trigger: TriggerNode };

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
  // Set in the create dialog / loaded with the workflow; carried through every
  // save so a described workflow never loses its description to the builder.
  const [description, setDescription] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [nodes, setNodes, onNodesChange] = useNodesState<GraphFlowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [started, setStarted] = useState(false);
  // Captured from ReactFlow's onInit so the canvas drop handler can map screen
  // coordinates to flow coordinates (screenToFlowPosition).
  const [rfInstance, setRfInstance] = useState<ReactFlowInstance<
    GraphFlowNode,
    Edge
  > | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // The right inspector only exists while a node is selected; its width is
  // drag-resizable from its left edge and persists like the palette's.
  const inspector = usePanelWidth({
    storageKey: 'geniro.builder.inspectorWidth',
    defaultWidth: 300,
    minWidth: 240,
    maxWidth: 480,
    handleEdge: 'left',
  });

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
        setDescription(workflow.description ?? '');
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

  /** "New workflow" opens the create dialog — nothing exists until Create. */
  const newWorkflow = useCallback((): void => {
    setError(null);
    setCreateOpen(true);
  }, []);

  /**
   * Create-dialog submit: persist a fresh EMPTY workflow (name + description
   * from the dialog, blank canvas — nodes come from the palette), then
   * redirect into the builder for it. On failure the dialog stays open
   * showing the error.
   */
  const createWorkflow = useCallback(
    async (meta: { name: string; description?: string }): Promise<void> => {
      if (!api) {
        return;
      }
      setCreating(true);
      setError(null);
      try {
        const saved = await api.create(fromFlow(meta, [], []));
        setCreateOpen(false);
        await openWorkflow(saved.slug);
      } catch (err) {
        setError(String(err));
      } finally {
        setCreating(false);
      }
    },
    [api, openWorkflow],
  );

  /** Close the builder and return to the library grid (refreshing the list so
   *  a just-saved workflow's card reflects its new node count / mtime). */
  const backToLibrary = useCallback((): void => {
    setStarted(false);
    setActiveSlug(null);
    setSelectedNodeId(null);
    setName('');
    setDescription('');
    setNodes([]);
    setEdges([]);
    setError(null);
    setNotice(null);
    void refreshList();
  }, [refreshList, setNodes, setEdges]);

  const save = useCallback(async (): Promise<void> => {
    if (!api) {
      return;
    }
    setError(null);
    try {
      const trimmedDescription = description.trim();
      const workflow = fromFlow(
        {
          name: name.trim() || 'workflow',
          ...(trimmedDescription ? { description: trimmedDescription } : {}),
        },
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
  }, [api, name, description, nodes, edges, activeSlug, refreshList]);

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
      setDescription('');
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

  const addNode = useCallback(
    (item: PaletteItem, position?: { x: number; y: number }): void => {
      const id = nextNodeId(new Set(nodes.map((n) => n.id)), item.kind);
      const maxX = nodes.reduce((max, n) => Math.max(max, n.position.x), -260);
      // Toolbar adds stack to the right; a drop lands where it was dropped.
      const at = position ?? { x: maxX + 260, y: 40 };
      const node: GraphFlowNode =
        item.kind === 'trigger'
          ? {
              id,
              type: 'trigger',
              position: at,
              data: { node: { id, kind: 'trigger', trigger: item.trigger } },
            }
          : {
              id,
              type: 'agent',
              position: at,
              data: {
                node: {
                  id,
                  kind: 'agent',
                  agent: item.agent,
                  approval: 'auto',
                },
              },
            };
      setNodes((prev) => [...prev, node]);
      setSelectedNodeId(id);
    },
    [nodes, setNodes],
  );

  const onCanvasDragOver = useCallback((event: React.DragEvent): void => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);

  const onCanvasDrop = useCallback(
    (event: React.DragEvent): void => {
      event.preventDefault();
      const item = parsePaletteItem(event.dataTransfer.getData(NODE_DND_MIME));
      if (!rfInstance || !item) {
        return;
      }
      const position = rfInstance.screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });
      addNode(item, position);
    },
    [rfInstance, addNode],
  );

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
      // Normalize to the canonical handle pair derived from the endpoint
      // kinds (the same ids toFlow derives) — a drag may have grabbed any of
      // the stacked collapsed handles, but with one rule per (side, kind)
      // there is exactly one correct pair.
      const kindOf = (id: string): NodeKind | undefined =>
        nodes.find((n) => n.id === id)?.data.node.kind;
      const sourceKind = kindOf(connection.source);
      const targetKind = kindOf(connection.target);
      setEdges((prev) =>
        addEdge(
          {
            ...connection,
            id: edgeId(connection.source, connection.target),
            sourceHandle: targetKind
              ? makeHandleId('source', targetKind)
              : connection.sourceHandle,
            targetHandle: sourceKind
              ? makeHandleId('target', sourceKind)
              : connection.targetHandle,
          },
          prev,
        ),
      );
    },
    [nodes, setEdges],
  );

  /**
   * Live drag predicate: an edge may only be wired when the connection rules
   * allow the (source kind → target kind) pair — the same registry the daemon
   * enforces on save. Also refuses self-loops so the invalid wire never draws.
   */
  const isValidConnection = useCallback(
    (connection: Connection | Edge): boolean => {
      if (
        !connection.source ||
        !connection.target ||
        connection.source === connection.target
      ) {
        return false;
      }
      const kindOf = (id: string): string | undefined =>
        nodes.find((n) => n.id === id)?.data.node.kind;
      const sourceKind = kindOf(connection.source);
      const targetKind = kindOf(connection.target);
      return (
        sourceKind !== undefined &&
        targetKind !== undefined &&
        canConnect(sourceKind, targetKind)
      );
    },
    [nodes],
  );

  /**
   * Patch the selected node's workflow data (inspector edits). The inspector
   * only sends fields belonging to the selected node's own kind and never
   * `kind` itself, so the spread stays within the node's union branch — the
   * cast just tells TS what the per-kind field editors guarantee.
   */
  const patchSelected = useCallback(
    (
      patch: Partial<
        Omit<WorkflowAgentNode, 'kind'> & Omit<WorkflowTriggerNode, 'kind'>
      >,
    ): void => {
      if (!selectedNodeId) {
        return;
      }
      setNodes((prev) =>
        prev.map((n) =>
          n.id === selectedNodeId
            ? ({
                ...n,
                data: { node: { ...n.data.node, ...patch } as WorkflowNode },
              } as GraphFlowNode)
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

  // Library grid — the landing view: one card per workflow with its metadata.
  // Clicking a card (or "New workflow") opens the builder below.
  if (!started) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <header className="flex items-center gap-2 border-b border-border px-4 py-3">
          <div className="flex flex-col">
            <h2 className="font-medium">Workflows</h2>
            <p className="text-xs text-muted-foreground">
              Compose a team of agents as a graph. Runs start from the Chats
              page.
            </p>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              className="gap-2"
              onClick={() => void importWorkflow()}>
              <Upload className="shrink-0" /> Import YAML…
            </Button>
            <Button type="button" className="gap-2" onClick={newWorkflow}>
              <Plus className="shrink-0" /> New workflow
            </Button>
          </div>
        </header>

        {error ? (
          <ErrorText className="border-b border-border px-4 py-1.5">
            {error}
          </ErrorText>
        ) : null}

        {summaries.length === 0 ? (
          <EmptyState className="flex-1">
            <div className="flex flex-col items-center gap-4">
              <WorkflowIcon
                aria-hidden="true"
                className="size-10 text-muted-foreground/50"
              />
              <p className="max-w-sm text-sm text-muted-foreground">
                No workflows yet. Create one to start composing your agent team,
                or import an existing <code>.geniro.yaml</code>.
              </p>
              <Button type="button" className="gap-2" onClick={newWorkflow}>
                <Plus className="shrink-0" /> New workflow
              </Button>
            </div>
          </EmptyState>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(240px,1fr))]">
              {summaries.map((summary) => (
                <WorkflowCard
                  key={summary.slug}
                  summary={summary}
                  onOpen={() => void openWorkflow(summary.slug)}
                />
              ))}
            </div>
          </div>
        )}

        <CreateWorkflowDialog
          open={createOpen}
          busy={creating}
          error={createOpen ? error : null}
          onClose={() => setCreateOpen(false)}
          onCreate={(meta) => void createWorkflow(meta)}
        />
      </div>
    );
  }

  // Builder — a single workflow open on the canvas + node inspector.
  return (
    <section className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <Button
          type="button"
          variant="ghost"
          className="gap-1.5"
          aria-label="Back to library"
          onClick={backToLibrary}>
          <ArrowLeft className="shrink-0" /> Library
        </Button>
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
          onClick={() => addNode({ kind: 'agent', agent: 'claude' })}>
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
              <ConfirmButton
                variant="outline"
                className="gap-1.5"
                aria-label="Delete workflow"
                confirmLabel="Delete?"
                onConfirm={remove}>
                <Trash2 className="shrink-0" />
              </ConfirmButton>
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

      <div className="flex min-h-0 flex-1">
        <NodePalette />

        <div
          className="relative min-w-0 flex-1 [overscroll-behavior:none]"
          onDrop={onCanvasDrop}
          onDragOver={onCanvasDragOver}>
          {/* Figma-style navigation, mirroring geniro's GraphCanvas: two-finger
              scroll PANS (free, any direction), scroll never zooms — zoom is
              pinch or Cmd+scroll (React Flow's default zoomActivationKey). */}
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={NODE_TYPES}
            onInit={(instance) => setRfInstance(instance)}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            isValidConnection={isValidConnection}
            onSelectionChange={({ nodes: sel }) =>
              setSelectedNodeId(sel[0]?.id ?? null)
            }
            fitView
            deleteKeyCode={['Delete', 'Backspace']}
            minZoom={0.1}
            maxZoom={4}
            panOnScroll
            panOnScrollMode={PanOnScrollMode.Free}
            zoomOnScroll={false}
            proOptions={{ hideAttribution: true }}>
            <Background />
            <Controls />
          </ReactFlow>
        </div>

        {selected ? (
          <aside
            style={{ width: inspector.width }}
            className="relative flex min-h-0 shrink-0 flex-col border-l border-border bg-muted/30">
            <PanelResizeHandle
              edge="left"
              label="Resize inspector"
              onMouseDown={inspector.startResize}
            />
            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
              <div className="flex items-center gap-2 border-b border-border bg-card px-4 py-3">
                {selected.kind === 'trigger' ? (
                  <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-success/15 text-success">
                    <Zap aria-hidden="true" className="size-3.5" />
                  </span>
                ) : (
                  <AgentAvatar
                    label={selected.name ?? selected.id}
                    className="size-7 text-xs"
                  />
                )}
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold">
                    {selected.name ?? selected.id}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {selected.kind === 'trigger'
                      ? `${selected.trigger} trigger`
                      : selected.agent}
                  </p>
                </div>
              </div>
              <div className="flex flex-col gap-4 p-4">
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
                {selected.kind === 'trigger' ? (
                  <NoteBox>
                    Runs start here: firing this {selected.trigger} trigger
                    seeds every connected agent with the prompt you submit.
                  </NoteBox>
                ) : (
                  <>
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
                  </>
                )}
                <Button
                  type="button"
                  variant="outline"
                  className="gap-1.5"
                  onClick={deleteSelected}>
                  <Trash2 className="shrink-0" /> Delete node
                </Button>
              </div>
            </div>
          </aside>
        ) : null}
      </div>
    </section>
  );
}
