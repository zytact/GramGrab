import { Effect, Schedule, Schema } from 'effect';
import { blobToDataUrl } from '../lib/data-url.ts';
import {
  GraphQLRequestFailed,
  HttpError,
  NetworkError,
  RateLimited,
  ResponseShapeUnknown,
} from './errors.ts';
import {
  HdAvatarResponseSchema,
  HighlightsTrayResponseSchema,
  MediaInfoResponseSchema,
  ReelsMediaResponseSchema,
  WebProfileInfoResponseSchema,
} from './schemas.ts';
import type {
  HdAvatarUser,
  HighlightsTrayItem,
  MediaInfoItem,
  ReelItem,
  WebProfileInfoUser,
} from './schemas.ts';

const GRAPHQL_RETRY_SCHEDULE = Schedule.exponential('200 millis').pipe(
  Schedule.compose(Schedule.recurs(3))
);

export const graphqlFetch = (
  url: string,
  operationKey: 'doc_id' | 'query_hash',
  operationId: string,
  variables: Record<string, unknown>,
  headers: Record<string, string>
): Effect.Effect<Record<string, unknown>, NetworkError | GraphQLRequestFailed | RateLimited> => {
  const attempt = Effect.gen(function* () {
    const qs = new URLSearchParams({
      [operationKey]: operationId,
      variables: JSON.stringify(variables),
    });
    const res = yield* Effect.tryPromise({
      try: () => fetch(`${url}?${qs}`, { credentials: 'include', headers }),
      catch: cause => new NetworkError({ cause }),
    });
    if (!res.ok) {
      if (res.status === 429) return yield* Effect.fail(new RateLimited({ status: 429 }));
      return yield* Effect.fail(new GraphQLRequestFailed({ status: res.status }));
    }
    return yield* Effect.tryPromise({
      try: () => res.json() as Promise<Record<string, unknown>>,
      catch: cause => new NetworkError({ cause }),
    });
  });

  return attempt.pipe(
    Effect.retry({
      schedule: GRAPHQL_RETRY_SCHEDULE,
      while: err =>
        err._tag === 'NetworkError' ||
        err._tag === 'RateLimited' ||
        (err._tag === 'GraphQLRequestFailed' && err.status >= 500),
    })
  );
};

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

export const fetchReelsMedia = (
  graphqlUrl: string,
  operationKey: 'doc_id' | 'query_hash',
  operationId: string,
  variables: Record<string, unknown>,
  headers: Record<string, string>
): Effect.Effect<
  readonly ReelItem[],
  NetworkError | GraphQLRequestFailed | RateLimited | ResponseShapeUnknown
> =>
  Effect.gen(function* () {
    const raw = yield* graphqlFetch(graphqlUrl, operationKey, operationId, variables, headers);
    const decoded = yield* Schema.decodeUnknown(ReelsMediaResponseSchema)(raw).pipe(
      Effect.mapError(() => new ResponseShapeUnknown({ context: 'reels_media' }))
    );
    return decoded.data.reels_media;
  });

export const fetchHdAvatarUser = (
  userId: string,
  headers: Record<string, string>
): Effect.Effect<HdAvatarUser | undefined, never> =>
  Effect.tryPromise({
    try: async () => {
      const res = await fetch(`https://i.instagram.com/api/v1/users/${userId}/info/`, {
        credentials: 'include',
        headers: { ...headers, Origin: 'https://www.instagram.com' },
      });
      if (!res.ok) return undefined;
      const json = (await res.json()) as unknown;
      const decoded = await Effect.runPromise(
        Schema.decodeUnknown(HdAvatarResponseSchema)(json).pipe(Effect.option)
      );
      // decoded is Option<HdAvatarResponse>; return user or undefined
      return decoded._tag === 'Some' ? decoded.value.user : undefined;
    },
    catch: () => undefined,
  }).pipe(Effect.catchAll(() => Effect.succeed(undefined)));

export const fetchMediaInfo = (
  mediaId: string,
  headers: Record<string, string>
): Effect.Effect<MediaInfoItem | undefined, never> =>
  Effect.tryPromise({
    try: async () => {
      const res = await fetch(`https://i.instagram.com/api/v1/media/${mediaId}/info/`, {
        credentials: 'include',
        headers: { ...headers, Origin: 'https://www.instagram.com' },
      });
      if (!res.ok) return undefined;
      const json = (await res.json()) as unknown;
      const decoded = await Effect.runPromise(
        Schema.decodeUnknown(MediaInfoResponseSchema)(json).pipe(Effect.option)
      );
      return decoded._tag === 'Some' ? decoded.value.items?.[0] : undefined;
    },
    catch: () => undefined,
  }).pipe(Effect.catchAll(() => Effect.succeed(undefined)));

export const fetchHighlightsTray = (
  userId: string,
  headers: Record<string, string>
): Effect.Effect<
  readonly HighlightsTrayItem[],
  HttpError | NetworkError | RateLimited | ResponseShapeUnknown
> =>
  Effect.gen(function* () {
    const url = `https://i.instagram.com/api/v1/highlights/${encodeURIComponent(userId)}/highlights_tray/`;
    const res = yield* Effect.tryPromise({
      try: () => fetch(url, { credentials: 'include', headers }),
      catch: cause => new NetworkError({ cause }),
    });
    if (!res.ok) {
      if (res.status === 429) return yield* Effect.fail(new RateLimited({ status: 429 }));
      return yield* Effect.fail(new HttpError({ status: res.status, message: res.statusText }));
    }
    const json = yield* Effect.tryPromise({
      try: () => res.json() as Promise<unknown>,
      catch: cause => new NetworkError({ cause }),
    });
    const decoded = yield* Schema.decodeUnknown(HighlightsTrayResponseSchema)(json).pipe(
      Effect.mapError(() => new ResponseShapeUnknown({ context: 'highlights_tray' }))
    );
    return decoded.tray;
  });
