import { AuthContextStorage } from './auth-context-storage';
import { AuthProvider } from './providers/auth.provider';

export interface IContextData {
  sub?: string;
  roles?: string[];
  [key: string]: unknown;
}

export interface IAuthModuleParams {
  provider?: AuthProvider;
  storage?: typeof AuthContextStorage;
  devMode?: boolean;
}
