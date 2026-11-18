import { createContext } from 'react';

import type { DaemonApis } from '../daemon-api';

/**
 * The agents API client (`/v1/agents`). Provided by `Chats`, which holds the
 * daemon handle: a lessons card names its models through it, and every model
 * price drawn in a chat is read through it (`useModelPrice`). Null shows the
 * raw model id and no price.
 */
export const AgentsApiContext = createContext<DaemonApis['agents'] | null>(
  null,
);
