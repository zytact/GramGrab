import { noteViewerPicture } from './viewer-avatar.ts';
import { Data, Effect, Option, Schema } from 'effect';
import { AccountId, InstagramUsername, type InstagramLogin } from '@gramgrab/protocol';
import { protocolConfig } from '../instagram-protocol/config.ts';
import { readHomePage } from '../instagram/dtsg.ts';
import { IG_API_GRAPHQL_HEADERS } from '../instagram/headers.ts';
import { InstagramRequests, requireOk } from '../instagram/requests.ts';
import { browser } from '../lib/browser.ts';
import { markLinkedEnded } from '../instagram/linked-login.ts';
import { CachedViewer, VIEWER_KEYS, decodeCachedViewer } from './contracts.ts';
import { AnswerUntrusted, NetworkError, ResponseShapeUnknown } from '../effect/errors.ts';

/** Instagram's home page named no signed-in viewer. */
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

/** A confirmed account, with its Avatar URLs for transient use. */
export interface Profile extends Account {
  readonly pictureUrl?: string;
  readonly hdPictureUrl?: string;
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

const PolarisViewer = Schema.parseJson(
  Schema.Struct({
    data: Schema.NullOr(
      Schema.Struct({
        id: WireAccountId,
        username: InstagramUsername,
        profile_pic_url: Schema.optional(Schema.NullOr(Schema.String)),
      })
    ),
  })
);
const VIEWER_MARKER = '"PolarisViewer",[],';

/** A JSON string, consumed whole so its braces never count, or a brace. */
const JSON_BRACE = /"(?:[^"\\]|\\.)*"|[{}]/g;

/** The JSON object that opens at `start`, found by matching its braces. */
function objectAt(text: string, start: number) {
  if (text[start] !== '{') return undefined;
  let depth = 0;
  for (const match of text.slice(start).matchAll(JSON_BRACE)) {
    if (match[0] === '{') depth++;
    else if (match[0] === '}' && --depth === 0) return text.slice(start, start + match.index + 1);
  }
  return undefined;
}

/** The home page's `PolarisViewer` block, which Instagram Web renders for the signed-in viewer. */
const viewerBlock = (page: string) => {
  const marker = page.indexOf(VIEWER_MARKER);
  return marker < 0 ? undefined : objectAt(page, marker + VIEWER_MARKER.length);
};

const ProfileResponse = Schema.Struct({
  data: Schema.Struct({
    user: Schema.NullOr(
      Schema.Struct({
        id: Schema.optional(WireAccountId),
        pk: Schema.optional(WireAccountId),
        username: InstagramUsername,
        profile_pic_url: Schema.optional(Schema.NullOr(Schema.String)),
        hd_profile_pic_url_info: Schema.optional(
          Schema.NullOr(Schema.Struct({ url: Schema.String }))
        ),
      })
    ),
  }),
  errors: Schema.optional(Schema.Array(Schema.Unknown)),
});

/** The JSON body of a successful response. A body that is not JSON is one bad answer. */
export const readJson = (response: Response) =>
  Effect.gen(function* () {
    yield* requireOk(response);
    return yield* Effect.tryPromise({
      try: (): Promise<unknown> => response.json(),
      catch: cause =>
        cause instanceof SyntaxError
          ? new AnswerUntrusted({ reason: 'not-json' })
          : new NetworkError({ cause }),
    });
  });

export async function cachedViewer(login: InstagramLogin): Promise<Account | undefined> {
  const key = VIEWER_KEYS[login];
  const stored = await browser.sessionStorage.get(key).catch((): Record<string, unknown> => ({}));
  return Option.getOrUndefined(decodeCachedViewer(stored[key]));
}

export const verifiedViewerId = async (login: InstagramLogin) =>
  (await cachedViewer(login))?.accountId;

/**
 * Identifies the viewer of the requests' login from Instagram's home page, never from a cookie, and
 * records it for `cachedViewer`. When no viewer is signed in it drops that record, and a linked
 * login is marked ended.
 */
export const fetchViewer = Effect.gen(function* () {
  const requests = yield* InstagramRequests;
  const key = VIEWER_KEYS[requests.login];
  const { page } = yield* readHomePage;
  return yield* Effect.gen(function* () {
    const { data: user } = yield* Schema.decodeUnknown(PolarisViewer)(viewerBlock(page)).pipe(
      Effect.mapError(() => new ResponseShapeUnknown({ context: 'watch_viewer' }))
    );
    if (!user) return yield* Effect.fail(new ViewerMissing());
    return {
      accountId: user.id,
      username: user.username,
      ...(user.profile_pic_url ? { pictureUrl: user.profile_pic_url } : {}),
    } satisfies Viewer;
  }).pipe(
    Effect.tap(viewer =>
      Effect.promise(() => {
        noteViewerPicture(viewer);
        const cached = CachedViewer.make({
          accountId: viewer.accountId,
          username: viewer.username,
        });
        return browser.sessionStorage.set({ [key]: cached }).catch(() => undefined);
      })
    ),
    Effect.tapError(error =>
      error._tag === 'ViewerMissing'
        ? Effect.promise(async () => {
            await browser.sessionStorage.remove(key).catch(() => undefined);
            if (requests.login === 'linked') await markLinkedEnded().catch(() => undefined);
          })
        : Effect.void
    )
  );
});

type ProfileUser = NonNullable<Schema.Schema.Type<typeof ProfileResponse>['data']['user']>;

/** Whether every identity field the profile carries is `targetId`, and it carries at least one. */
const isAccount = ({ id, pk }: ProfileUser, targetId: string) => {
  const ids = [id, pk].filter(value => value !== undefined);
  return ids.length > 0 && ids.every(value => value === targetId);
};

/** The profile only when the response is error-free and every identity field is `targetId`. */
function confirmedProfile(
  response: Schema.Schema.Type<typeof ProfileResponse>,
  targetId: string
): Profile | undefined {
  const user = response.data.user;
  if (!user || (response.errors?.length ?? 0) > 0 || !isAccount(user, targetId)) return undefined;
  return {
    accountId: targetId,
    username: user.username,
    pictureUrl: user.profile_pic_url ?? undefined,
    hdPictureUrl: user.hd_profile_pic_url_info?.url,
  };
}

/**
 * Reads the current username and Avatar of `targetId` from the ID-keyed profile query. Only a
 * successful, error-free response whose every identity field equals `targetId` confirms it, so an
 * old username taken over by another account can never be followed.
 */
export const confirmProfile = (targetId: string) =>
  Effect.gen(function* () {
    const candidate = protocolConfig.operations.profileById.candidates[0]!;
    const request = candidate.requests[0]!;
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
      csrf: true,
      headers: { ...IG_API_GRAPHQL_HEADERS, 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const decoded = yield* Schema.decodeUnknown(ProfileResponse)(yield* readJson(response)).pipe(
      Effect.mapError(() => new ResponseShapeUnknown({ context: 'watch_profile' }))
    );
    const profile = confirmedProfile(decoded, targetId);
    if (!profile) return yield* Effect.fail(new UsernameUnconfirmed());
    return profile;
  });
