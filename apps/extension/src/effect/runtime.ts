import { Effect } from 'effect';
import type { OperationFailure } from '../errors/contracts.ts';

export function runOperationHandler<T extends object, E extends object, E0>(
  program: Effect.Effect<T, E0, never>,
  errorDefaults: E,
  normalize: (error: E0) => OperationFailure
): Promise<(T & { failure: undefined }) | (E & { failure: OperationFailure })> {
  return Effect.runPromise(
    program.pipe(
      Effect.map(payload => ({ ...payload, failure: undefined as undefined })),
      Effect.catchAll(error => Effect.succeed({ ...errorDefaults, failure: normalize(error) }))
    )
  );
}
