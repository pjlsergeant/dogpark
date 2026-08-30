/**
 * Which client the app talks to.
 */
import type { DogparkAdminApi } from './api.js';
import { createHttpApi } from './http.js';

export type { DogparkAdminApi } from './api.js';
export * from './types.js';

export function createApi(): DogparkAdminApi {
  return createHttpApi();
}
