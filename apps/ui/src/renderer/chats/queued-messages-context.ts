import { createContext } from 'react';

/**
 * How many messages the open chat's composer queue holds. A run_team card that
 * starts the chat's team waits while it holds any: the daemon cannot see the
 * renderer's queue, so the card reads the count from here.
 */
export const QueuedMessagesContext = createContext<number>(0);
