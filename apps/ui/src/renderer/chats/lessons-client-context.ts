import { createContext, type ReactNode } from 'react';

import type { DaemonClient } from '../daemon-client';
import type { LessonModelChoice } from './lesson-model-picker';

/** The daemon client a lesson offer listens to for `lessons_changed`; null leaves it to re-read on its own presses and while a reflection runs. */
export const LessonsClientContext = createContext<DaemonClient | null>(null);

/** Draws the agent and model picker for an offer's "Change model…". */
export type LessonModelPickerRender = (
  value: LessonModelChoice,
  onChange: (next: LessonModelChoice) => void,
) => ReactNode;

/** The picker a lesson offer's "Change model…" draws; null leaves the offer without one. */
export const LessonsModelPickerContext =
  createContext<LessonModelPickerRender | null>(null);
