/**
 * Which client the app talks to.
 *
 * The real one is the default and the only one a production build can reach.
 * The mock is behind a build-time flag *and* a dynamic import, so it is not
 * merely unused in production — it is never loaded.
 */
import type { DogparkAdminApi } from './api.js';
import { createHttpApi } from './http.js';

export type { DogparkAdminApi } from './api.js';
export * from './types.js';

export const usingMock = import.meta.env['VITE_DOGPARK_MOCK'] === '1';

export async function createApi(): Promise<DogparkAdminApi> {
  if (usingMock) {
    const { createMockApi } = await import('./mock/client.js');
    return createMockApi();
  }
  return createHttpApi();
}
