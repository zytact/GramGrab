import { Effect, Schema } from 'effect';
import { HttpError, NetworkError, RateLimited, ResponseShapeUnknown } from '../effect/errors.ts';
import { protocolConfig } from '../instagram-protocol/config.ts';
import type { MediaItem } from './normalize.ts';

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export function shortcodeMediaId(shortcode: string): string | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(shortcode)) return undefined;
  let id = 0n;
  for (const character of shortcode) id = id * 64n + BigInt(alphabet.indexOf(character));
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

export const fetchRestShortcodeRaw = (
  shortcode: string
): Effect.Effect<unknown, HttpError | NetworkError | RateLimited | ResponseShapeUnknown> =>
  Effect.gen(function* () {
    const id = shortcodeMediaId(shortcode);
    if (!id) return yield* Effect.fail(unknownShape());
    const response = yield* Effect.tryPromise({
      try: () =>
        fetch(`https://www.instagram.com/api/v1/media/${id}/info/`, {
          credentials: 'include',
          headers: {
            'X-IG-App-ID': protocolConfig.client.appId,
            'X-ASBD-ID': protocolConfig.client.asbdId,
            'X-Requested-With': 'XMLHttpRequest',
            Accept: 'application/json',
          },
        }),
      catch: cause => new NetworkError({ cause }),
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

export const fetchRestShortcodeMedia = (
  shortcode: string
): Effect.Effect<MediaItem[], HttpError | NetworkError | RateLimited | ResponseShapeUnknown> =>
  Effect.gen(function* () {
    const raw = yield* fetchRestShortcodeRaw(shortcode);
    const decoded = yield* decode(RestShortcodeResponseSchema, raw);
    if (decoded.status !== 'ok') return yield* Effect.fail(unknownShape());
    if (!decoded.items.length) return [];
    const match = decoded.items.find(item => item.code === shortcode);
    if (!match) return yield* Effect.fail(unknownShape());
    return yield* decodeRestItem(match, shortcode);
  });
