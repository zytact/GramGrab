import { Effect, Schedule, Schema } from 'effect';
import { blobToDataUrl } from '../lib/data-url.ts';
import { InstagramRequests, type WatchRequestDeferred } from '../instagram/requests.ts';
import {
  GraphQLRequestFailed,
  HttpError,
  NetworkError,
  RateLimited,
  ResponseShapeUnknown,
} from './errors.ts';
import {
  HighlightsTrayResponseSchema,
  InstantsFeedResponseSchema,
  ReelsMediaResponseSchema,
} from './schemas.ts';
import type { HighlightsTrayItem, ReelItem } from './schemas.ts';
import type { InstantItem } from './schemas.ts';

const GRAPHQL_RETRY_SCHEDULE = Schedule.exponential('200 millis').pipe(
  Schedule.compose(Schedule.recurs(3))
);

const shouldRetryGraphqlError = (
  err:
    | NetworkError
    | GraphQLRequestFailed
    | RateLimited
    | ResponseShapeUnknown
    | WatchRequestDeferred
): boolean =>
  err._tag === 'NetworkError' ||
  err._tag === 'RateLimited' ||
  (err._tag === 'GraphQLRequestFailed' && err.status >= 500);

const requireSuccessfulResponse = <E>(
  response: Response,
  rejected: (response: Response) => E
): Effect.Effect<void, E | RateLimited> => {
  if (response.ok) return Effect.void;
  if (response.status === 429) return Effect.fail(new RateLimited({ status: 429 }));
  return Effect.fail(rejected(response));
};

const parseGraphqlJson = (
  response: Response
): Effect.Effect<Record<string, unknown>, NetworkError | ResponseShapeUnknown> => {
  if (response.headers?.get('content-type')?.includes('text/html'))
    return Effect.fail(new ResponseShapeUnknown({ context: 'graphql_response' }));
  return Effect.tryPromise({
    try: async (): Promise<unknown> => response.json(),
    catch: cause =>
      cause instanceof SyntaxError
        ? new ResponseShapeUnknown({ context: 'graphql_response' })
        : new NetworkError({ cause }),
  }).pipe(
    Effect.flatMap(raw =>
      Schema.decodeUnknown(Schema.Record({ key: Schema.String, value: Schema.Unknown }))(raw)
    ),
    Effect.mapError(error =>
      error._tag === 'ParseError'
        ? new ResponseShapeUnknown({ context: 'graphql_response' })
        : error
    )
  );
};

const parseInstagramLsdToken = (html: string): string | undefined =>
  html.match(/"LSD",\[\],\{"token":"([^"]+)"/)?.[1] ??
  html.match(/"lsd":"([^"]+)"/)?.[1] ??
  html.match(/name="lsd"\s+value="([^"]+)"/)?.[1];

const getInstagramLsdToken = (): Effect.Effect<string | undefined, never, InstagramRequests> => {
  const inputToken =
    globalThis.document?.querySelector<HTMLInputElement>('input[name="lsd"]')?.value;
  if (inputToken) return Effect.succeed(inputToken);

  const cookieToken = globalThis.document?.cookie.match(/(?:^|;\s*)lsd=([^;]+)/)?.[1];
  if (cookieToken) return Effect.succeed(cookieToken);

  return Effect.gen(function* () {
    const requests = yield* InstagramRequests;
    const res = yield* requests.fetch('https://www.instagram.com/', {
      credentials: 'include',
      headers: { Accept: 'text/html' },
    });
    if (!res.ok) return undefined;
    const html = yield* Effect.tryPromise(() => res.text());
    return parseInstagramLsdToken(html);
  }).pipe(Effect.catchAll(() => Effect.succeed(undefined)));
};

export const graphqlFetch = (
  url: string,
  operationKey: 'doc_id' | 'query_hash',
  operationId: string,
  variables: Record<string, unknown>,
  headers: Record<string, string>
): Effect.Effect<
  Record<string, unknown>,
  NetworkError | GraphQLRequestFailed | RateLimited | ResponseShapeUnknown | WatchRequestDeferred,
  InstagramRequests
> => {
  const attempt = Effect.gen(function* () {
    const qs = new URLSearchParams({
      [operationKey]: operationId,
      variables: JSON.stringify(variables),
    });
    const requests = yield* InstagramRequests;
    const res = yield* requests.fetch(`${url}?${qs}`, { credentials: 'include', headers });
    yield* requireSuccessfulResponse(
      res,
      response => new GraphQLRequestFailed({ status: response.status })
    );
    return yield* parseGraphqlJson(res);
  });

  return attempt.pipe(
    Effect.retry({
      schedule: GRAPHQL_RETRY_SCHEDULE,
      while: shouldRetryGraphqlError,
    })
  );
};

export const graphqlPost = (
  url: string,
  operationId: string,
  variables: Record<string, unknown>,
  headers: Record<string, string>,
  operationKey: 'doc_id' | 'query_hash' = 'doc_id'
): Effect.Effect<
  Record<string, unknown>,
  NetworkError | GraphQLRequestFailed | RateLimited | ResponseShapeUnknown | WatchRequestDeferred,
  InstagramRequests
> => {
  const attempt = Effect.gen(function* () {
    const lsd = yield* getInstagramLsdToken();
    const body = new URLSearchParams({
      [operationKey]: operationId,
      variables: JSON.stringify(variables),
    });
    if (lsd) body.set('lsd', lsd);
    const requests = yield* InstagramRequests;
    const res = yield* requests.fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: {
        ...headers,
        'Content-Type': 'application/x-www-form-urlencoded',
        ...(lsd ? { 'X-FB-LSD': lsd } : {}),
      },
      body,
    });
    yield* requireSuccessfulResponse(
      res,
      response => new GraphQLRequestFailed({ status: response.status })
    );
    return yield* parseGraphqlJson(res);
  });

  return attempt.pipe(
    Effect.retry({
      schedule: GRAPHQL_RETRY_SCHEDULE,
      while: shouldRetryGraphqlError,
    })
  );
};

export const fetchInstantsFeed = (
  url: string,
  clientDocumentId: string,
  friendlyName: string,
  csrfToken: string,
  headers: Record<string, string>
): Effect.Effect<
  readonly InstantItem[],
  NetworkError | GraphQLRequestFailed | RateLimited | ResponseShapeUnknown | WatchRequestDeferred,
  InstagramRequests
> =>
  Effect.gen(function* () {
    const variables = JSON.stringify({ request: {} });
    const body = new URLSearchParams({
      fb_api_req_friendly_name: friendlyName,
      client_doc_id: clientDocumentId,
      variables,
      server_timestamps: 'true',
    });
    const requests = yield* InstagramRequests;
    const res = yield* requests.fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: {
        ...headers,
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-FB-Friendly-Name': friendlyName,
        'X-Client-Doc-Id': clientDocumentId,
        ...(csrfToken ? { 'X-CSRFToken': csrfToken } : {}),
      },
      body,
    });
    yield* requireSuccessfulResponse(
      res,
      response => new GraphQLRequestFailed({ status: response.status })
    );
    const raw = yield* Effect.tryPromise({
      try: () => res.json() as Promise<unknown>,
      catch: cause => new NetworkError({ cause }),
    });
    const decoded = yield* Schema.decodeUnknown(InstantsFeedResponseSchema)(raw).pipe(
      Effect.mapError(() => new ResponseShapeUnknown({ context: 'instants_feed' }))
    );
    return decoded.data.xdt_get_quick_snaps.items_ordered_by_time;
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

type RestContext = 'highlights_tray';

/** Reads a REST endpoint and decodes it, reporting a decode failure as ResponseShapeUnknown. */
const fetchDecodedJson = <A, I>(
  url: string,
  init: RequestInit,
  schema: Schema.Schema<A, I>,
  context: RestContext
): Effect.Effect<
  A,
  HttpError | NetworkError | RateLimited | ResponseShapeUnknown | WatchRequestDeferred,
  InstagramRequests
> =>
  Effect.gen(function* () {
    const requests = yield* InstagramRequests;
    const res = yield* requests.fetch(url, init);
    yield* requireSuccessfulResponse(
      res,
      response => new HttpError({ status: response.status, message: response.statusText })
    );
    const json = yield* Effect.tryPromise({
      try: () => res.json() as Promise<unknown>,
      catch: cause => new NetworkError({ cause }),
    });
    return yield* Schema.decodeUnknown(schema)(json).pipe(
      Effect.mapError(() => new ResponseShapeUnknown({ context }))
    );
  });

export const fetchReelsMedia = (
  graphqlUrl: string,
  operationKey: 'doc_id' | 'query_hash',
  operationId: string,
  variables: Record<string, unknown>,
  headers: Record<string, string>,
  method: 'GET' | 'POST' = 'GET'
): Effect.Effect<
  readonly ReelItem[],
  NetworkError | GraphQLRequestFailed | RateLimited | ResponseShapeUnknown | WatchRequestDeferred,
  InstagramRequests
> =>
  Effect.gen(function* () {
    const raw = yield* method === 'POST'
      ? graphqlPost(graphqlUrl, operationId, variables, headers, operationKey)
      : graphqlFetch(graphqlUrl, operationKey, operationId, variables, headers);
    const decoded = yield* Schema.decodeUnknown(ReelsMediaResponseSchema)(raw).pipe(
      Effect.mapError(() => new ResponseShapeUnknown({ context: 'reels_media' }))
    );
    return decoded.data.reels_media;
  });

export const fetchHighlightsTray = (
  userId: string,
  headers: Record<string, string>
): Effect.Effect<
  readonly HighlightsTrayItem[],
  HttpError | NetworkError | RateLimited | ResponseShapeUnknown | WatchRequestDeferred,
  InstagramRequests
> =>
  fetchDecodedJson(
    `https://i.instagram.com/api/v1/highlights/${encodeURIComponent(userId)}/highlights_tray/`,
    { credentials: 'include', headers },
    HighlightsTrayResponseSchema,
    'highlights_tray'
  ).pipe(Effect.map(decoded => decoded.tray));
