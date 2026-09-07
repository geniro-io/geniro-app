import { Plus } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { DaemonHandle } from '../../shared/contracts';
import { EmptyState } from '../components/empty-state';
import { ErrorBanner } from '../components/error-banner';
import { Button } from '../components/ui/button';
import { createDaemonApis, type DaemonApis } from '../daemon-api';
import type { DaemonClient } from '../daemon-client';
import { BoardColumn } from './board-column';
import { NewProjectDialog } from './new-project-dialog';
import { NewTaskDialog } from './new-task-dialog';
import { ProjectPicker } from './project-picker';
import { TaskDetail } from './task-detail';
import { BOARD_COLUMNS, boardColumns, useBoard } from './use-board';

export function Tasks({
  handle,
  client,
  active,
}: {
  handle: DaemonHandle | null;
  client: DaemonClient | null;
  /**
   * Whether this screen is the one on show. The board is latch-mounted and
   * never remounts, so becoming visible again is the only moment it can
   * notice a project deleted from Settings while it was hidden.
   */
  active: boolean;
}): React.JSX.Element {
  const [apis, setApis] = useState<DaemonApis | null>(null);
  useEffect(() => {
    setApis(handle ? createDaemonApis(handle) : null);
  }, [handle]);

  const board = useBoard(apis, client);
  const refreshProjects = board.refreshProjects;
  useEffect(() => {
    if (active) {
      refreshProjects();
    }
  }, [active, refreshProjects]);
  const [draggingTaskId, setDraggingTaskId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [newTaskOpen, setNewTaskOpen] = useState(false);

  // A keyboard move re-parents the card into another column's subtree, so the
  // node that had focus is unmounted and focus falls to <body>. Re-claim it on
  // the card's new node, or the next arrow press goes nowhere.
  const refocusTaskId = useRef<string | null>(null);
  useEffect(() => {
    const id = refocusTaskId.current;
    if (id === null) {
      return;
    }
    refocusTaskId.current = null;
    // Scanned rather than interpolated into a selector: the id is daemon
    // data, so a selector built from it would need escaping to be correct.
    const node = [
      ...document.querySelectorAll<HTMLElement>('[data-task-id]'),
    ].find((el) => el.dataset.taskId === id);
    node?.focus();
  }, [board.tasks]);

  const onCardKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>, taskId: string) => {
      // Alt rather than a bare arrow: the cards are buttons in a scrolling
      // pane, and a bare arrow has to stay available for moving THROUGH them.
      if (!event.altKey) {
        return;
      }
      const step =
        event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0;
      if (step === 0) {
        return;
      }
      const task = board.tasks.find((row) => row.id === taskId);
      if (task === undefined) {
        return;
      }
      const from = BOARD_COLUMNS.indexOf(task.status);
      // -1 is a status this build does not know, and `-1 + 1` indexes the FIRST
      // column — a nudge rightwards would silently reclassify the card as
      // Backlog and tell the daemon it came from a column it was never in.
      if (from === -1) {
        return;
      }
      const next = BOARD_COLUMNS[from + step];
      if (next === undefined) {
        return;
      }
      event.preventDefault();
      refocusTaskId.current = taskId;
      void board.moveTask(taskId, next);
    },
    [board],
  );

  const projectId = board.selectedProjectId;
  const openTask = board.tasks.find((row) => row.id === openTaskId) ?? null;

  if (!handle) {
    return <EmptyState>Connecting to the daemon…</EmptyState>;
  }

  return (
    <div className="flex h-full min-h-0">
      <ProjectPicker
        projects={board.projects}
        selectedProjectId={board.selectedProjectId}
        onSelect={board.selectProject}
        onNewProject={() => {
          setNewProjectOpen(true);
        }}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        {board.error !== null ? (
          <ErrorBanner
            message={board.error}
            onDismiss={board.dismissError}
            className="m-3"
          />
        ) : null}

        {board.selectedProjectId === null ? (
          <EmptyState>
            Create a project to start a board. A project binds a folder; its
            tasks are the cards.
          </EmptyState>
        ) : (
          <>
            <div className="flex items-center justify-end px-3 pt-3">
              <Button
                size="sm"
                onClick={() => {
                  setNewTaskOpen(true);
                }}>
                <Plus className="size-4" aria-hidden />
                New task
              </Button>
            </div>
            {board.loading && board.tasks.length === 0 ? (
              <EmptyState>Loading the board…</EmptyState>
            ) : null}
            {/* The COLUMNS scroll horizontally and each scrolls its own cards;
              the page itself never scrolls. */}
            <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-3">
              {boardColumns(board.tasks).map((status) => (
                <BoardColumn
                  key={status}
                  status={status}
                  tasks={board.tasks.filter((row) => row.status === status)}
                  selectedTaskId={openTaskId}
                  draggingTaskId={draggingTaskId}
                  isDropTarget={dropTarget === status}
                  onOpenTask={setOpenTaskId}
                  onDragStartTask={setDraggingTaskId}
                  onDragEndTask={() => {
                    setDraggingTaskId(null);
                    setDropTarget(null);
                  }}
                  onTaskKeyDown={onCardKeyDown}
                  onDragOver={(event) => {
                    if (draggingTaskId === null) {
                      return;
                    }
                    // After the foreign-drag guard above and before anything
                    // else. A dragover that returns without calling this is a
                    // dragover the browser reads as "not a drop target", and
                    // the card animates back to where it started.
                    event.preventDefault();
                    event.dataTransfer.dropEffect = 'move';
                    setDropTarget(status);
                  }}
                  onDragLeave={() => {
                    setDropTarget((current) =>
                      current === status ? null : current,
                    );
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    const taskId = draggingTaskId;
                    setDraggingTaskId(null);
                    setDropTarget(null);
                    if (taskId !== null) {
                      void board.moveTask(taskId, status);
                    }
                  }}
                />
              ))}
            </div>
          </>
        )}
      </div>

      {openTask !== null ? (
        <TaskDetail
          // Keyed so a task switch REMOUNTS: the panel seeds its title and
          // description drafts from props at mount only, so a reused instance
          // carries the previous card's text and blur writes it onto this one.
          key={openTask.id}
          task={openTask}
          onClose={() => {
            setOpenTaskId(null);
          }}
          onSave={(patch) => {
            void board.updateTask(openTask.id, patch);
          }}
        />
      ) : null}

      <NewProjectDialog
        open={newProjectOpen}
        onClose={() => {
          setNewProjectOpen(false);
        }}
        onCreate={(input) => {
          setNewProjectOpen(false);
          void board.createProject(input);
        }}
      />
      {projectId !== null ? (
        <NewTaskDialog
          open={newTaskOpen}
          onClose={() => {
            setNewTaskOpen(false);
          }}
          onCreate={(input) => {
            setNewTaskOpen(false);
            void board.createTask({
              projectId,
              title: input.title,
              description: input.description || undefined,
            });
          }}
        />
      ) : null}
    </div>
  );
}
