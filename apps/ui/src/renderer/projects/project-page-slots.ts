import { createContext } from 'react';

/**
 * Where a project page section draws what sits beside or under the page
 * rather than in it: the member sheet on the right, the chat dock at the
 * bottom. Null until the page has laid them out.
 */
export interface ProjectPageSlots {
  sheet: HTMLElement | null;
  dock: HTMLElement | null;
}

export const ProjectPageSlotsContext = createContext<ProjectPageSlots>({
  sheet: null,
  dock: null,
});
