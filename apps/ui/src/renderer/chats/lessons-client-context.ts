import { createContext } from 'react';

import type { DaemonClient } from '../daemon-client';

/** The daemon client a lesson offer listens to for `lessons_changed`; null leaves it to re-read on its own presses and while a reflection runs. */
export const LessonsClientContext = createContext<DaemonClient | null>(null);
