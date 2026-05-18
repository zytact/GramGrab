import { Effect, Schema } from 'effect';
import { blobToDataUrl } from '../lib/data-url.ts';
import { GraphQLRequestFailed, HttpError, NetworkError, ResponseShapeUnknown } from './errors.ts';
import { WebProfileInfoResponseSchema } from './schemas.ts';
import type { WebProfileInfoUser } from './schemas.ts';

export const graphqlFetch = (
  url: string,
  operationKey: 'doc_id' | 'query_hash',
  operationId: string,
  variables: Record<string, unknown>,
  headers: Record<string, string>
): Effect.Effect<Record<string, unknown>, NetworkError | GraphQLRequestFailed> =>
  Effect.gen(function* () {
    const qs = new URLSearchParams({
      [operationKey]: operationId,
      variables: JSON.stringify(variables),
    });
    const res = yield* Effect.tryPromise({
      try: () => fetch(`${url}?${qs}`, { credentials: 'include', headers }),
      catch: cause => new NetworkError({ cause }),
    });
    if (!res.ok) return yield* Effect.fail(new GraphQLRequestFailed({ status: res.status }));
    return yield* Effect.tryPromise({
      try: () => res.json() as Promise<Record<string, unknown>>,
      catch: cause => new NetworkError({ cause }),
    });
  });

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
