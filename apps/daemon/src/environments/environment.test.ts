import {
  type DaemonEnvironment,
  environment as prodEnvironment,
} from './environment.prod';

export const environment = (): DaemonEnvironment => ({
  ...prodEnvironment(),
  env: 'test',
});
