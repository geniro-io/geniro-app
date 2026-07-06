import {
  BaseEdge,
  EdgeLabelRenderer,
  type EdgeProps,
  getBezierPath,
} from '@xyflow/react';
import { useState } from 'react';

/**
 * The `call` edge component (registered as React Flow edge type `call`) — a
 * dashed amber bezier so "may invoke at runtime" wires read differently from
 * the solid data-flow edges, with a small `call` chip at the midpoint while
 * the edge is hovered or selected. All colours come from the warning token.
 */
/** Back-edge loop geometry: horizontal reach past the handles, drop below
 *  the lower endpoint (clears the card bottom — handles sit near it), and
 *  the rounded-corner radius. */
const LOOP_EXT = 24;
const LOOP_DIP = 64;
const LOOP_RADIUS = 12;

/**
 * Path for a BACK edge (target left of the source — every mutual call pair
 * has one): the default bezier between a right-side source and a left-side
 * target at similar heights degenerates to a near-straight line that runs
 * BEHIND both node cards (edges render under nodes), leaving only orphaned
 * stubs visible at the handles. Route it the way node editors draw feedback
 * wires instead: out of the source, down just below the cards, straight
 * across, and up into the target — a tight rounded-orthogonal loop.
 */
function backEdgePath(
  sourceX: number,
  sourceY: number,
  targetX: number,
  targetY: number,
): [string, number, number] {
  const r = LOOP_RADIUS;
  const right = sourceX + LOOP_EXT;
  const left = targetX - LOOP_EXT;
  const dip = Math.max(sourceY, targetY) + LOOP_DIP;
  const path =
    `M ${sourceX},${sourceY} H ${right - r} Q ${right},${sourceY} ${right},${sourceY + r} ` +
    `V ${dip - r} Q ${right},${dip} ${right - r},${dip} ` +
    `H ${left + r} Q ${left},${dip} ${left},${dip - r} ` +
    `V ${targetY + r} Q ${left},${targetY} ${left + r},${targetY} H ${targetX}`;
  // Chip on the middle of the bottom run.
  return [path, (right + left) / 2, dip];
}

export function CallEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  selected,
}: EdgeProps): React.JSX.Element {
  const [hovered, setHovered] = useState(false);
  const [path, labelX, labelY] =
    targetX < sourceX
      ? backEdgePath(sourceX, sourceY, targetX, targetY)
      : getBezierPath({
          sourceX,
          sourceY,
          sourcePosition,
          targetX,
          targetY,
          targetPosition,
        });
  return (
    // The group wraps BaseEdge's visible path AND its wide invisible
    // interaction path, so the hover chip triggers from the whole hit area.
    <g
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}>
      {/* Arrowhead pointing INTO the callee — a call permission is
          directional, and without a marker the wire reads as symmetric.
          Every call edge re-declares the same def; browsers resolve the
          shared id to the first one, so the duplication is inert. */}
      <defs>
        <marker
          id="geniro-call-arrow"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="7"
          markerHeight="7"
          orient="auto-start-reverse">
          <path d="M 0 1.5 L 9 5 L 0 8.5 z" fill="var(--color-warning)" />
        </marker>
      </defs>
      <BaseEdge
        id={id}
        path={path}
        markerEnd="url(#geniro-call-arrow)"
        style={{
          stroke: 'var(--color-warning)',
          strokeWidth: selected ? 2 : 1.5,
          strokeDasharray: '6 4',
        }}
      />
      {selected || hovered ? (
        <EdgeLabelRenderer>
          <span
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            }}
            className="pointer-events-none absolute rounded bg-warning px-1.5 py-0.5 text-[10px] font-semibold text-warning-foreground">
            call
          </span>
        </EdgeLabelRenderer>
      ) : null}
    </g>
  );
}
