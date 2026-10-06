import { Effect } from 'effect';
import type { OperationFailure } from '../errors/contracts.ts';
import { PersonRequests, type InstagramRequests } from '../instagram/requests.ts';

/** Runs work the person asked for, so its Instagram requests are accounted as person-initiated. */
export function runOperationHandler<T extends object, E extends object, E0>(
  program: Effect.Effect<T, E0, InstagramRequests>,
  errorDefaults: E,
  normalize: (error: E0) => OperationFailure
): Promise<(T & { failure: undefined }) | (E & { failure: OperationFailure })> {
  return Effect.runPromise(
    program.pipe(
      Effect.map(payload => ({ ...payload, failure: undefined as undefined })),
      Effect.catchAll(error => Effect.succeed({ ...errorDefaults, failure: normalize(error) })),
      Effect.provide(PersonRequests)
    )
  );
}
