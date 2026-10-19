import { Effect } from 'effect';
import type { InstagramLogin } from '@gramgrab/protocol';
import type { OperationFailure } from '../errors/contracts.ts';
import type { LinkedLoginUnavailable } from './errors.ts';
import { PersonRequests, type InstagramRequests } from '../instagram/requests.ts';
import { requireLogin } from '../instagram/linked-login.ts';

/**
 * Runs work the person asked for as `login`, so its Instagram requests carry that login's session
 * and are accounted as person-initiated.
 */
export function runOperationHandler<T extends object, E extends object, E0>(
  program: Effect.Effect<T, E0, InstagramRequests>,
  errorDefaults: E,
  normalize: (error: E0 | LinkedLoginUnavailable) => OperationFailure,
  login: InstagramLogin = 'main'
): Promise<(T & { failure: undefined }) | (E & { failure: OperationFailure })> {
  return Effect.runPromise(
    Effect.zipRight(requireLogin(login), program).pipe(
      Effect.map(payload => ({ ...payload, failure: undefined as undefined })),
      Effect.catchAll(error => Effect.succeed({ ...errorDefaults, failure: normalize(error) })),
      Effect.provide(PersonRequests(login))
    )
  );
}
