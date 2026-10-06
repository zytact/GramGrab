import { Effect, Schema } from 'effect';
import { HttpError, NetworkError, RateLimited, ResponseShapeUnknown } from '../effect/errors.ts';
import { protocolConfig } from '../instagram-protocol/config.ts';
import { InstagramRequests } from './requests.ts';
import type { MediaItem } from './normalize.ts';

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const PRIVATE_SHORTCODE_SUFFIX_LENGTH = 28;

/** Private-account posts append a 28-character suffix that is not part of the media ID. */
export function shortcodeMediaId(shortcode: string): string | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(shortcode)) return undefined;
  const encoded =
    shortcode.length > PRIVATE_SHORTCODE_SUFFIX_LENGTH
      ? shortcode.slice(0, -PRIVATE_SHORTCODE_SUFFIX_LENGTH)
      : shortcode;
  let id = 0n;
  for (const character of encoded) id = id * 64n + BigInt(alphabet.indexOf(character));
  return id.toString();
}

const VersionSchema = Schema.Struct({
  url: Schema.String,
  width: Schema.Number,
  height: Schema.Number,
});

type Version = Schema.Schema.Type<typeof VersionSchema>;
const ImageVersionsSchema = Schema.Struct({ candidates: Schema.Array(VersionSchema) });
const RestBase = {
  pk: Schema.String,
  code: Schema.optional(Schema.String),
  taken_at: Schema.optional(Schema.Number),
};
const RestImageSchema = Schema.Struct({
  ...RestBase,
  media_type: Schema.Literal(1),
  image_versions2: ImageVersionsSchema,
});
const RestVideoSchema = Schema.Struct({
  ...RestBase,
  media_type: Schema.Literal(2),
  video_versions: Schema.Array(VersionSchema),
  image_versions2: Schema.optional(Schema.NullOr(ImageVersionsSchema)),
});
const RestUnknownSchema = Schema.Struct({
  ...RestBase,
  media_type: Schema.Number.pipe(Schema.filter(value => ![1, 2, 8].includes(value))),
});
const RestChildSchema = Schema.Union(RestImageSchema, RestVideoSchema, RestUnknownSchema);
const RestSidecarSchema = Schema.Struct({
  ...RestBase,
  media_type: Schema.Literal(8),
  carousel_media: Schema.Array(RestChildSchema),
});
const RestMediaSchema = Schema.Union(
  RestImageSchema,
  RestVideoSchema,
  RestSidecarSchema,
  RestUnknownSchema
);
const RestMediaTypeSchema = Schema.Struct({ media_type: Schema.Number });

export const RestShortcodeResponseSchema = Schema.Struct({
  items: Schema.Array(RestMediaSchema),
  status: Schema.String,
});

const unknownShape = () => new ResponseShapeUnknown({ context: 'shortcode_media' });

const OwnerIdentity = Schema.Struct({
  pk: Schema.optional(Schema.String),
  id: Schema.optional(Schema.String),
  pk_id: Schema.optional(Schema.String),
});
const ChildIdentity = Schema.Struct({ pk: Schema.String, media_type: Schema.Number });
const WatchMediaIdentity = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({
      pk: Schema.String,
      code: Schema.String,
      media_type: Schema.Number,
      user: OwnerIdentity,
      owner: Schema.optional(OwnerIdentity),
      coauthor_producers: Schema.optional(Schema.NullOr(Schema.Array(OwnerIdentity))),
      carousel_media: Schema.optional(Schema.NullOr(Schema.Array(ChildIdentity))),
    })
  ),
});
type WatchMediaItem = Schema.Schema.Type<typeof WatchMediaIdentity>['items'][number];

interface ExpectedMedia {
  readonly parentId: string;
  /** The account that authored or co-authored the media. */
  readonly accountId: string;
  readonly mediaType: 1 | 2 | 8;
  readonly children?: readonly {
    readonly mediaId: string;
    readonly mediaType: 'image' | 'video';
  }[];
}

const ownerMatches = (owner: Schema.Schema.Type<typeof OwnerIdentity>, expected: string) => {
  const ids = Object.values(owner);
  return ids.length > 0 && ids.every(id => id === expected);
};

const childrenMatch = (
  children: readonly Schema.Schema.Type<typeof ChildIdentity>[] | undefined | null,
  expected: ExpectedMedia['children']
) =>
  expected === undefined ||
  (children !== undefined &&
    children !== null &&
    expected.every(ref => {
      const matches = children.filter(child => child.pk === ref.mediaId);
      const [child] = matches;
      return (
        matches.length === 0 ||
        (matches.length === 1 && child?.media_type === (ref.mediaType === 'image' ? 1 : 2))
      );
    }));

/** A collab lists the account as a co-author while another account owns the media. */
const belongsTo = (item: WatchMediaItem, accountId: string) =>
  (ownerMatches(item.user, accountId) &&
    (item.owner === undefined || ownerMatches(item.owner, accountId))) ||
  (item.coauthor_producers ?? []).some(coauthor => ownerMatches(coauthor, accountId));

const mediaMatches = (item: WatchMediaItem, expected: ExpectedMedia) =>
  item.pk === expected.parentId &&
  item.media_type === expected.mediaType &&
  belongsTo(item, expected.accountId) &&
  childrenMatch(item.carousel_media, expected.children);

const verifyExpectedMedia = (raw: unknown, shortcode: string, expected: ExpectedMedia) =>
  decode(WatchMediaIdentity, raw).pipe(
    Effect.filterOrFail(response => {
      const matches = response.items.filter(item => item.code === shortcode);
      const [item] = matches;
      return matches.length === 1 && item !== undefined && mediaMatches(item, expected);
    }, unknownShape)
  );

const decode = <A, I>(schema: Schema.Schema<A, I>, value: unknown) =>
  Schema.decodeUnknown(schema)(value).pipe(Effect.mapError(unknownShape));

function bestVersion(versions: readonly Version[] | undefined): Version | undefined {
  return [...(versions ?? [])].sort((left, right) => right.width - left.width)[0];
}

function itemFromVersion(
  pk: string,
  shortcode: string,
  type: 'video' | 'image',
  source: Version | undefined,
  takenAt: number | undefined,
  previewUrl?: string
): Effect.Effect<MediaItem, ResponseShapeUnknown> {
  if (!source) return Effect.fail(unknownShape());
  return Effect.succeed({
    itemIndex: 0,
    mediaId: pk,
    type,
    url: source.url,
    previewUrl,
    width: source.width,
    height: source.height,
    takenAt,
    filenameHint: `${shortcode}_${type === 'video' ? 'GraphVideo' : 'GraphImage'}`,
  });
}

const decodeImage = (raw: unknown, shortcode: string, parentTakenAt?: number) =>
  decode(RestImageSchema, raw).pipe(
    Effect.flatMap(media =>
      itemFromVersion(
        media.pk,
        shortcode,
        'image',
        bestVersion(media.image_versions2.candidates),
        media.taken_at ?? parentTakenAt
      )
    ),
    Effect.map(item => [item])
  );

const decodeVideo = (raw: unknown, shortcode: string, parentTakenAt?: number) =>
  decode(RestVideoSchema, raw).pipe(
    Effect.flatMap(media =>
      itemFromVersion(
        media.pk,
        shortcode,
        'video',
        bestVersion(media.video_versions),
        media.taken_at ?? parentTakenAt,
        bestVersion(media.image_versions2?.candidates)?.url
      )
    ),
    Effect.map(item => [item])
  );

function decodeSidecar(
  raw: unknown,
  shortcode: string,
  parentTakenAt?: number
): Effect.Effect<MediaItem[], ResponseShapeUnknown> {
  return Effect.gen(function* () {
    const media = yield* decode(RestSidecarSchema, raw);
    if (!media.carousel_media.length) return yield* Effect.fail(unknownShape());
    const children: MediaItem[] = [];
    for (const child of media.carousel_media) {
      children.push(...(yield* decodeRestItem(child, shortcode, media.taken_at ?? parentTakenAt)));
    }
    if (!children.length) return yield* Effect.fail(unknownShape());
    return children;
  });
}

function decodeRestItem(
  raw: unknown,
  shortcode: string,
  parentTakenAt?: number
): Effect.Effect<MediaItem[], ResponseShapeUnknown> {
  return Effect.gen(function* () {
    const { media_type } = yield* decode(RestMediaTypeSchema, raw);
    if (media_type === 1) return yield* decodeImage(raw, shortcode, parentTakenAt);
    if (media_type === 2) return yield* decodeVideo(raw, shortcode, parentTakenAt);
    if (media_type === 8) return yield* decodeSidecar(raw, shortcode, parentTakenAt);
    return [];
  });
}

export const fetchRestShortcodeRaw = (shortcode: string) =>
  Effect.gen(function* () {
    const id = shortcodeMediaId(shortcode);
    if (!id) return yield* Effect.fail(unknownShape());
    const requests = yield* InstagramRequests;
    const response = yield* requests.fetch(`https://www.instagram.com/api/v1/media/${id}/info/`, {
      credentials: 'include',
      headers: {
        'X-IG-App-ID': protocolConfig.client.appId,
        'X-ASBD-ID': protocolConfig.client.asbdId,
        'X-Requested-With': 'XMLHttpRequest',
        Accept: 'application/json',
      },
    });
    if (response.status === 429) return yield* Effect.fail(new RateLimited({ status: 429 }));
    if (!response.ok)
      return yield* Effect.fail(
        new HttpError({ status: response.status, message: response.statusText })
      );
    return yield* Effect.tryPromise({
      try: async (): Promise<unknown> => response.json(),
      catch: cause => (cause instanceof SyntaxError ? unknownShape() : new NetworkError({ cause })),
    });
  });

export const fetchRestShortcodeMedia = (shortcode: string, expected?: ExpectedMedia) =>
  Effect.gen(function* () {
    const raw = yield* fetchRestShortcodeRaw(shortcode);
    if (expected) yield* verifyExpectedMedia(raw, shortcode, expected);
    const decoded = yield* decode(RestShortcodeResponseSchema, raw);
    if (decoded.status !== 'ok') return yield* Effect.fail(unknownShape());
    if (!decoded.items.length) return [];
    const match = decoded.items.find(item => item.code === shortcode);
    if (!match) return yield* Effect.fail(unknownShape());
    return yield* decodeRestItem(match, shortcode);
  });
