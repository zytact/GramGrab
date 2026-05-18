import { Effect, Schema } from 'effect';
import { blobToDataUrl } from '../lib/data-url.ts';
import { HttpError, NetworkError, ResponseShapeUnknown } from './errors.ts';
import { WebProfileInfoResponseSchema } from './schemas.ts';
import type { WebProfileInfoUser } from './schemas.ts';

export const fetchBlobAsDataUrl = (url: string) =>
  Effect.gen(function* () {
    const res = yield* Effect.tryPromise({
      try: () => fetch(url, { credentials: 'omit' }),
      catch: cause => new NetworkError({ cause }),
    });
    if (!res.ok)
      return yield* Effect.fail(new HttpError({ status: res.status, message: res.statusText }));
    const blob = yield* Effect.tryPromise({
      try: () => res.blob(),
      catch: cause => new NetworkError({ cause }),
    });
    return yield* Effect.tryPromise({
      try: () => blobToDataUrl(blob),
      catch: cause => new NetworkError({ cause }),
    });
  });

export const fetchWebProfileInfoUser = (
  url: string,
  credentials: RequestCredentials,
  headers: Record<string, string>
): Effect.Effect<WebProfileInfoUser | undefined, HttpError | NetworkError | ResponseShapeUnknown> =>
  Effect.gen(function* () {
    const res = yield* Effect.tryPromise({
      try: () => fetch(url, { credentials, headers }),
      catch: cause => new NetworkError({ cause }),
    });
    if (!res.ok)
      return yield* Effect.fail(new HttpError({ status: res.status, message: res.statusText }));
    const json = yield* Effect.tryPromise({
      try: () => res.json() as Promise<unknown>,
      catch: cause => new NetworkError({ cause }),
    });
    const decoded = yield* Schema.decodeUnknown(WebProfileInfoResponseSchema)(json).pipe(
      Effect.mapError(() => new ResponseShapeUnknown({ context: 'web_profile_info' }))
    );
    return decoded.data?.user;
  });
