/** The one place a screen gets hold of the client. */
import { createContext, useContext } from 'react';
import type { DogparkAdminApi } from '../api/index.js';

export interface Session {
  /** `DOGPARK_DISPLAY_NAME`, as the server reports it. */
  readonly displayName: string;
  /**
   * True when the server is running on the README's example password. The
   * shell keeps a banner up while it is; anyone who has read the README can
   * sign in.
   */
  /** Optional so a test fixture need not know about the banner; only `true` shows it. */
  readonly examplePassword?: boolean;
}

interface AppContextValue {
  readonly api: DogparkAdminApi;
  readonly session: Session;
  readonly logout: () => void;
}

const AppContext = createContext<AppContextValue | null>(null);

export const AppProvider = AppContext.Provider;

export function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (value === null) throw new Error('useApp outside the provider');
  return value;
}

export function useApi(): DogparkAdminApi {
  return useApp().api;
}
