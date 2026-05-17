import { Effect } from 'effect';

export { Effect };

export const runPromise = Effect.runPromise;

// Phase 2: replace with formatError from errors.ts
function serializeError(err: unknown): string {
  return String(err);
}

export function runHandler<T extends object>(
  program: Effect.Effect<T, unknown, never>
): Promise<T & { error: string | undefined }> {
  return Effect.runPromise(
    program.pipe(
      Effect.map(payload => ({ ...payload, error: undefined as string | undefined })),
      Effect.catchAll(err =>
        Effect.succeed({ error: serializeError(err) } as T & { error: string | undefined })
      )
    )
  );
}
