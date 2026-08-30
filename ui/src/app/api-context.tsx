/** The one place a screen gets hold of the client. */
import { createContext, useContext } from 'react';
import type { DogparkAdminApi } from '../api/index.js';

export interface Session {
  /**
   * The human's configured display name, when the server offers it. Null
   * otherwise: `POST /session` returns only a CSRF token, so the shell says
   * "signed in" rather than inventing a name.
   */
  readonly displayName: string;
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
