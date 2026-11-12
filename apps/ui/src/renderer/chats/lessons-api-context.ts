import { createContext } from 'react';

import type { DaemonApis } from '../daemon-api';

/**
 * The lessons API client (`/v1/lessons`). Provided by `Chats`, which holds the
 * daemon handle; a lessons card drawn without it has its buttons disabled.
 */
export const LessonsApiContext = createContext<DaemonApis['lessons'] | null>(
  null,
);
