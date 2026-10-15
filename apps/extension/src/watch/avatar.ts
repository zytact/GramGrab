import { Effect, Schema } from 'effect';
import { ResponseShapeUnknown } from '../effect/errors.ts';
import { PictureId } from './contracts.ts';
import { confirmProfile, type Profile } from './identity.ts';

/** The CDN asset name, the same in every size and signed URL of one picture. */
const assetName = (url: string) =>
  URL.parse(url)
    ?.pathname.split('/')
    .pop()
    ?.replace(/\.\w+$/, '');

/**
 * Reads the account's current picture identity from its confirmed profile, with the picture URLs
 * for transient use. The identity is the picture's asset name, which must be present and opaque.
 */
export const readAvatar = ({ pictureUrl, hdPictureUrl }: Profile) =>
  Effect.gen(function* () {
    const pictureId = pictureUrl && assetName(pictureUrl);
    if (!pictureUrl || !Schema.is(PictureId)(pictureId))
      return yield* Effect.fail(new ResponseShapeUnknown({ context: 'watch_avatar' }));
    return { pictureId, pictureUrl, hdPictureUrl: hdPictureUrl ?? pictureUrl };
  });

export type ObservedAvatar = Effect.Effect.Success<ReturnType<typeof readAvatar>>;

/** Reads the current picture of `targetId` through its ID-keyed profile. */
export const fetchAvatar = (targetId: string) =>
  confirmProfile(targetId).pipe(Effect.flatMap(readAvatar));
