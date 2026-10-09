import { noteViewerPicture } from './viewer-avatar.ts';
import { Data, Effect, Schema } from 'effect';
import { AccountId, InstagramUsername } from '@gramgrab/protocol';
import { protocolConfig } from '../instagram-protocol/config.ts';
import {
  IG_API_GRAPHQL_HEADERS,
  IG_GRAPHQL_HEADERS,
  readCsrfToken,
} from '../instagram/acquisition.ts';
import { InstagramRequests } from '../instagram/requests.ts';
import { browser } from '../lib/browser.ts';
import { VIEWER_KEY } from './contracts.ts';
import {
  GraphQLRequestFailed,
  NetworkError,
  RateLimited,
  ResponseShapeUnknown,
} from '../effect/errors.ts';

/** The session query answered, but with no signed-in viewer. */
class ViewerMissing extends Data.TaggedError('ViewerMissing') {}

/** An ID-keyed profile response that cannot confirm the stored target's current username. */
export class UsernameUnconfirmed extends Data.TaggedError('UsernameUnconfirmed') {}

export interface Account {
  readonly accountId: string;
  readonly username: string;
}

/** The signed-in login, with its Avatar URL for transient use. */
interface Viewer extends Account {
  readonly pictureUrl?: string;
}

/** An account ID as Instagram sends it: a decimal string, or a number only while it is exact. */
export const WireAccountId = Schema.Union(
  AccountId,
  Schema.transform(
    Schema.Number.pipe(Schema.int(), Schema.positive(), Schema.filter(Number.isSafeInteger)),
    AccountId,
    { strict: true, decode: String, encode: Number }
  )
);

const ViewerResponse = Schema.Struct({
  data: Schema.Struct({
    user: Schema.NullOr(
      Schema.Struct({
        id: WireAccountId,
        username: InstagramUsername,
        profile_pic_url: Schema.optional(Schema.NullOr(Schema.String)),
      })
    ),
  }),
  errors: Schema.optional(Schema.Array(Schema.Unknown)),
});

const ProfileResponse = Schema.Struct({
  data: Schema.Struct({
    user: Schema.NullOr(
      Schema.Struct({
        id: Schema.optional(WireAccountId),
        pk: Schema.optional(WireAccountId),
        username: InstagramUsername,
      })
    ),
  }),
  errors: Schema.optional(Schema.Array(Schema.Unknown)),
});

export const readJson = (response: Response, context: string) =>
  Effect.gen(function* () {
    if (response.status === 429) return yield* Effect.fail(new RateLimited({ status: 429 }));
    if (!response.ok)
      return yield* Effect.fail(new GraphQLRequestFailed({ status: response.status }));
    return yield* Effect.tryPromise({
      try: (): Promise<unknown> => response.json(),
      catch: cause =>
        cause instanceof SyntaxError
          ? new ResponseShapeUnknown({ context })
          : new NetworkError({ cause }),
    });
  });

export async function verifiedViewerId(): Promise<string | undefined> {
  const stored = await browser.sessionStorage
    .get(VIEWER_KEY)
    .catch((): Record<string, unknown> => ({}));
  const decoded = Schema.decodeUnknownOption(AccountId)(stored[VIEWER_KEY]);
  return decoded._tag === 'Some' ? decoded.value : undefined;
}

/**
 * Identifies the signed-in viewer from the dedicated session query, never from a cookie, and
 * records its account ID for `verifiedViewerId`, or drops it when no viewer is signed in.
 */
export const fetchViewer = Effect.gen(function* () {
  const candidate = protocolConfig.operations.viewer.candidates[0]!;
  const request = candidate.requests[0]!;
  const query = new URLSearchParams({ [candidate.kind]: candidate.id, variables: '{}' });
  const requests = yield* InstagramRequests;
  const response = yield* requests.fetch(`${request.endpoint}?${query}`, {
    credentials: 'include',
    headers: IG_GRAPHQL_HEADERS,
  });
  if (response.status === 401) return yield* Effect.fail(new ViewerMissing());
  const decoded = yield* Schema.decodeUnknown(ViewerResponse)(
    yield* readJson(response, 'watch_viewer')
  ).pipe(Effect.mapError(() => new ResponseShapeUnknown({ context: 'watch_viewer' })));
  const user = decoded.data.user;
  if (!user || (decoded.errors?.length ?? 0) > 0) return yield* Effect.fail(new ViewerMissing());
  return {
    accountId: user.id,
    username: user.username,
    ...(user.profile_pic_url ? { pictureUrl: user.profile_pic_url } : {}),
  } satisfies Viewer;
}).pipe(
  Effect.tap(viewer =>
    Effect.promise(() => {
      noteViewerPicture(viewer);
      return browser.sessionStorage.set({ [VIEWER_KEY]: viewer.accountId }).catch(() => undefined);
    })
  ),
  Effect.tapError(error =>
    error._tag === 'ViewerMissing'
      ? Effect.promise(() => browser.sessionStorage.remove(VIEWER_KEY).catch(() => undefined))
      : Effect.void
  )
);

/** The username only when the response is error-free and every identity field is `targetId`. */
function confirmedUsername(
  response: Schema.Schema.Type<typeof ProfileResponse>,
  targetId: string
): string | undefined {
  const user = response.data.user;
  if (!user || (response.errors?.length ?? 0) > 0) return undefined;
  const ids = [user.id, user.pk].filter(id => id !== undefined);
  return ids.length > 0 && ids.every(id => id === targetId) ? user.username : undefined;
}

/**
 * Reads the current username of `targetId` from the ID-keyed profile query. Only a successful,
 * error-free response whose every identity field equals `targetId` confirms it, so an old
 * username taken over by another account can never be followed.
 */
export const confirmProfile = (targetId: string) =>
  Effect.gen(function* () {
    const candidate = protocolConfig.operations.profileById.candidates[0]!;
    const request = candidate.requests[0]!;
    const csrfToken = yield* readCsrfToken;
    const body = new URLSearchParams({
      [candidate.kind]: candidate.id,
      server_timestamps: 'true',
      variables: JSON.stringify({
        enable_integrity_filters: true,
        id: targetId,
        render_surface: 'PROFILE',
        __relay_internal__pv__PolarisCannesGuardianExperienceEnabledrelayprovider: true,
        __relay_internal__pv__PolarisCASB976ProfileEnabledrelayprovider: false,
        __relay_internal__pv__PolarisWebSchoolsEnabledrelayprovider: false,
        __relay_internal__pv__PolarisRepostsConsumptionEnabledrelayprovider: false,
        __relay_internal__pv__PolarisShortDramaEnabledrelayprovider: false,
      }),
    });
    const requests = yield* InstagramRequests;
    const response = yield* requests.fetch(request.endpoint, {
      method: 'POST',
      credentials: 'include',
      headers: {
        ...IG_API_GRAPHQL_HEADERS,
        'Content-Type': 'application/x-www-form-urlencoded',
        ...(csrfToken ? { 'X-CSRFToken': csrfToken } : {}),
      },
      body,
    });
    const decoded = yield* Schema.decodeUnknown(ProfileResponse)(
      yield* readJson(response, 'watch_profile')
    ).pipe(Effect.mapError(() => new ResponseShapeUnknown({ context: 'watch_profile' })));
    const username = confirmedUsername(decoded, targetId);
    if (!username) return yield* Effect.fail(new UsernameUnconfirmed());
    return { accountId: targetId, username } satisfies Account;
  });
