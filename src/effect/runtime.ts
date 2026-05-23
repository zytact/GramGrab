import { Effect } from 'effect';
import { formatError } from './errors.ts';

export { Effect };

export const runPromise = Effect.runPromise;

export function runHandler<T extends object, E extends object, E0>(
  program: Effect.Effect<T, E0, never>,
  errorDefaults: E
): Promise<(T & { error: undefined }) | (E & { error: string })> {
  return Effect.runPromise(
    program.pipe(
      Effect.map(payload => ({ ...payload, error: undefined as undefined })),
      Effect.catchAll(err => Effect.succeed({ ...errorDefaults, error: formatError(err) }))
    )
  );
}
