import { BookOpen } from 'lucide-react';

import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { ProjectSection } from '../projects/project-section';

/** A project's documents on its page: how many, and the way to them. */
export function KnowledgeProjectSection({
  active,
  waiting,
  onOpen,
}: {
  /** Null until the first read lands. */
  active: number | null;
  waiting: number;
  onOpen: () => void;
}): React.JSX.Element {
  return (
    <ProjectSection
      slot="project-knowledge"
      icon={<BookOpen />}
      title="Knowledge"
      hint="Documents agents read when a task calls for them.">
      {active === null || active + waiting === 0 ? null : (
        <p className="flex flex-wrap items-center gap-2 text-sm">
          {active} {active === 1 ? 'document' : 'documents'}
          {waiting > 0 ? (
            <Badge variant="warning">{waiting} waiting</Badge>
          ) : null}
        </p>
      )}
      <div>
        <Button type="button" variant="outline" size="sm" onClick={onOpen}>
          Open knowledge
        </Button>
      </div>
    </ProjectSection>
  );
}
