import { useEffect, useRef } from 'react';

import type { AgentSkill } from '../../shared/contracts';
import { cn } from '../components/ui/utils';

/**
 * The `/` autocomplete popup — the target agent's available skills / slash
 * commands, floated above the composer card (rendered inside a `relative`
 * wrapper around it). Pure presentation: filtering, highlight movement, and
 * the keyboard protocol live with the composer state in Chats.tsx.
 */
export function SkillMenu({
  skills,
  highlightIndex,
  onSelect,
  onHighlight,
}: {
  skills: readonly AgentSkill[];
  highlightIndex: number;
  onSelect: (skill: AgentSkill) => void;
  onHighlight: (index: number) => void;
}): React.JSX.Element {
  // Keyboard movement (incl. wrap-around) can land the highlight outside the
  // 256px viewport — keep it visible. `nearest` makes hover moves a no-op.
  const highlightedRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    highlightedRef.current?.scrollIntoView({ block: 'nearest' });
  }, [highlightIndex]);
  return (
    <div
      role="listbox"
      aria-label="Available skills"
      className="absolute inset-x-0 bottom-full z-10 mb-2 max-h-64 overflow-y-auto rounded-xl border border-border bg-card p-1 shadow-panel-md">
      {skills.map((skill, index) => (
        <button
          key={`${skill.source}:${skill.kind}:${skill.name}`}
          ref={index === highlightIndex ? highlightedRef : null}
          type="button"
          role="option"
          aria-selected={index === highlightIndex}
          className={cn(
            'flex w-full cursor-pointer items-baseline gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm',
            index === highlightIndex && 'bg-accent text-accent-foreground',
          )}
          // Keep the textarea focused through a click — selecting re-writes
          // the input, and focus must never blur off the composer.
          onMouseDown={(event) => event.preventDefault()}
          onMouseEnter={() => onHighlight(index)}
          onClick={() => onSelect(skill)}>
          <span className="shrink-0 font-medium">/{skill.name}</span>
          {skill.description ? (
            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
              {skill.description}
            </span>
          ) : null}
          <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
            {skill.source}
          </span>
        </button>
      ))}
    </div>
  );
}
