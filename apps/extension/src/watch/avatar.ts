import { Effect, Schema } from 'effect';
import { IG_HEADERS } from '../instagram/acquisition.ts';
import { InstagramRequests } from '../instagram/requests.ts';
import { ResponseShapeUnknown } from '../effect/errors.ts';
import { PictureId } from './contracts.ts';
import { readJson } from './identity.ts';

const SearchId = Schema.optional(Schema.Union(Schema.String, Schema.Number));

const SearchResponse = Schema.Struct({
  users: Schema.Array(
    Schema.Struct({
      user: Schema.Struct({
        pk: SearchId,
        pk_id: SearchId,
        username: Schema.String,
        profile_pic_id: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    })
  ),
});

const untrusted = () => new ResponseShapeUnknown({ context: 'watch_avatar' });

/** An ID names `targetId` only when it is that exact string, or a number that is exactly it. */
const names = (id: string | number | undefined, targetId: string) =>
  typeof id === 'number' ? Number.isSafeInteger(id) && String(id) === targetId : id === targetId;

/**
 * Reads the target's current picture identity from a search answer. Exactly one result must be
 * the target by account ID and current username, and its picture ID must be present and opaque.
 */
export const readAvatar = (raw: unknown, targetId: string, username: string) =>
  Effect.gen(function* () {
    const { users } = yield* Schema.decodeUnknown(SearchResponse)(raw).pipe(
      Effect.mapError(untrusted)
    );
    const matches = users.filter(
      ({ user }) => names(user.pk, targetId) || names(user.pk_id, targetId)
    );
    const [match] = matches;
    const pictureId = match?.user.profile_pic_id;
    if (
      matches.length !== 1 ||
      match!.user.username.toLowerCase() !== username.toLowerCase() ||
      !Schema.is(PictureId)(pictureId)
    )
      return yield* Effect.fail(untrusted());
    return pictureId;
  });

/** Searches the target's verified current username for its exact search record. */
export const fetchAvatar = (username: string) =>
  Effect.gen(function* () {
    const requests = yield* InstagramRequests;
    const response = yield* requests.fetch(
      `https://www.instagram.com/web/search/topsearch/?context=blended&query=${encodeURIComponent(username)}`,
      { credentials: 'include', headers: IG_HEADERS }
    );
    return yield* readJson(response, 'watch_avatar');
  });
