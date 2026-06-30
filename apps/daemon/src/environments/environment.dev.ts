import { getEnv, type LogLevel } from '@packages/common';

import {
  type DaemonEnvironment,
  environment as prodEnvironment,
} from './environment.prod';

export const environment = (): DaemonEnvironment => ({
  ...prodEnvironment(),
  env: getEnv('NODE_ENV', 'development'),
  logLevel: 'debug' as LogLevel,
  prettyLog: true,
});
