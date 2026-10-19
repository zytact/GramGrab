import { Option, Schema } from 'effect';
import {
  ExportSettings,
  AccountId,
  CheckIncompleteReason,
  FailureCodeSchema,
  InstagramUsername,
  WatchActions,
  WatchKinds,
} from '@gramgrab/protocol';

/**
 * The persisted Watch store. Everything here is an allowlist: decoding rejects any field it does
 * not name, so media URLs, captions, names, cookies, or tokens cannot be stored by accident.
 */

const EpochMillis = Schema.Number.pipe(Schema.int(), Schema.nonNegative());
const EpochSeconds = Schema.Number.pipe(Schema.int(), Schema.nonNegative());

/** A Post, Story, or Sidecar child ID, or an Instant's `media_owner` composite, kept exactly. */
export const MediaId = Schema.String.pipe(Schema.pattern(/^\d{1,30}(?:_\d{1,30})?$/));
/** The CDN asset name of an Avatar's picture, opaque to GramGrab. */
export const PictureId = Schema.String.pipe(Schema.pattern(/^[0-9A-Za-z_:-]{1,128}$/));
export const Shortcode = Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9_-]{1,64}$/));
const MediaType = Schema.Literal('image', 'video');

export const STORE_KEY = 'watch-store';
/** Where the browser session records each login's last verified account ID. */
export const VIEWER_KEYS = { main: 'watch-viewer', linked: 'watch-viewer.linked' } as const;
export const STORE_VERSION = 2;
export const STORE_BUDGET_BYTES = 2 * 1024 * 1024;
/** Inbox entries and the discoveries behind them last this long after discovery. */
export const RETENTION_MS = 30 * 24 * 60 * 60_000;

const KindProblemRecord = Schema.Struct({
  code: FailureCodeSchema,
  /** The rule an incomplete check broke. A closed literal, so it cannot hold an identifier. */
  reason: Schema.optional(CheckIncompleteReason),
  at: EpochMillis,
});

/** Media the person fetched before a check found it, which later checks skip. */
const SeenMedia = Schema.Struct({ mediaId: MediaId, takenAt: EpochSeconds });

const TimedTracking = Schema.Struct({
  /** Publication second at or before which media is part of the baseline. Absent means pending. */
  baselineCutoff: Schema.optional(EpochSeconds),
  seen: Schema.optional(Schema.Array(SeenMedia)),
  lastSuccessAt: Schema.optional(EpochMillis),
  lastCheckAt: Schema.optional(EpochMillis),
  problem: Schema.optional(KindProblemRecord),
  /** A Posts traversal stopped at its page limit and continues on a later turn. */
  catchingUp: Schema.optional(Schema.Literal(true)),
});
export type TimedTracking = Schema.Schema.Type<typeof TimedTracking>;

const AvatarTracking = Schema.Struct({
  /** The last valid picture identity observed for the target. Absent means pending. */
  pictureId: Schema.optional(PictureId),
  lastSuccessAt: Schema.optional(EpochMillis),
  lastCheckAt: Schema.optional(EpochMillis),
  problem: Schema.optional(KindProblemRecord),
});
type AvatarTracking = Schema.Schema.Type<typeof AvatarTracking>;

const Tracking = Schema.Struct({
  posts: Schema.optional(TimedTracking),
  stories: Schema.optional(TimedTracking),
  instants: Schema.optional(TimedTracking),
  avatar: Schema.optional(AvatarTracking),
});
type Tracking = Schema.Schema.Type<typeof Tracking>;

const PostRef = Schema.TaggedStruct('Post', {
  mediaId: MediaId,
  shortcode: Shortcode,
  mediaType: MediaType,
  takenAt: EpochSeconds,
});

const SidecarChild = Schema.Struct({ mediaId: MediaId, mediaType: MediaType });

/** A Sidecar's children are frozen when it is discovered; later children are never added. */
const SidecarRef = Schema.TaggedStruct('Sidecar', {
  mediaId: MediaId,
  shortcode: Shortcode,
  takenAt: EpochSeconds,
  children: Schema.Array(SidecarChild).pipe(Schema.minItems(1)),
});

const StoryRef = Schema.TaggedStruct('Story', {
  mediaId: MediaId,
  mediaType: MediaType,
  takenAt: EpochSeconds,
  expiresAt: EpochSeconds,
});

const InstantRef = Schema.TaggedStruct('Instant', {
  mediaId: MediaId,
  mediaType: MediaType,
  takenAt: EpochSeconds,
});

const AvatarRef = Schema.TaggedStruct('Avatar', { pictureId: PictureId });

/**
 * Media the person fetched, keyed as a Watch check of `kind` would find it: a Post or Sidecar by
 * its own ID, never a child's. `owners` are the accounts whose Watches would find it.
 */
const FetchedMedia = Schema.Struct({
  kind: Schema.Literal('posts', 'stories', 'instants'),
  owners: Schema.Array(AccountId),
  mediaId: MediaId,
  takenAt: EpochSeconds,
});
export type FetchedMedia = Schema.Schema.Type<typeof FetchedMedia>;

const decodeFetched = Schema.decodeUnknownOption(FetchedMedia);

/** The candidates exact enough to mark seen. Any other is dropped rather than guessed at. */
export const fetchedMedia = (
  candidates: readonly {
    readonly [Key in keyof FetchedMedia]: Key extends 'kind' ? FetchedMedia['kind'] : unknown;
  }[]
): FetchedMedia[] => candidates.flatMap(candidate => Option.toArray(decodeFetched(candidate)));

/** A downscaled JPEG's base64 text, at most 8 KiB of image bytes. */
export const AvatarJpeg = Schema.String.pipe(
  Schema.pattern(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  Schema.minLength(4),
  Schema.maxLength(Math.ceil((8 * 1024) / 3) * 4),
  Schema.filter(
    jpeg =>
      (jpeg.length * 3) / 4 - (jpeg.endsWith('==') ? 2 : jpeg.endsWith('=') ? 1 : 0) <= 8 * 1024
  )
);

/** The cached picture shown beside the Watch, and when the image was cached. */
const AvatarImage = Schema.Struct({
  pictureId: PictureId,
  jpeg: AvatarJpeg,
  checkedAt: EpochMillis,
});

const MediaRef = Schema.Union(PostRef, SidecarRef, StoryRef, InstantRef, AvatarRef);
export type MediaRef = Schema.Schema.Type<typeof MediaRef>;
/** A reference to media with a publication time, which every kind but Avatar records. */
export type TimedRef = Exclude<MediaRef, { readonly _tag: 'Avatar' }>;

/**
 * The Instagram page that shows a reference, derived rather than stored. Instants and Avatars
 * have no page of their own, so they open the profile.
 */
export function instagramPage(username: string, ref: MediaRef): string {
  switch (ref._tag) {
    case 'Post':
    case 'Sidecar':
      return `https://www.instagram.com/p/${ref.shortcode}/`;
    case 'Story':
      return `https://www.instagram.com/stories/${username}/${ref.mediaId.split('_')[0]}/`;
    case 'Instant':
    case 'Avatar':
      return profilePage(username);
  }
}

export const profilePage = (username: string) => `https://www.instagram.com/${username}/`;

const NotifyRecord = Schema.Union(
  Schema.Struct({ status: Schema.Literal('pending') }),
  Schema.Struct({ status: Schema.Literal('done'), at: EpochMillis }),
  Schema.Struct({
    status: Schema.Literal('failed'),
    code: Schema.Literal('WATCH_NOTIFY_PERMISSION_DENIED', 'WATCH_NOTIFY_FAILED'),
    at: EpochMillis,
    dismissed: Schema.Boolean,
  })
);
type NotifyRecord = Schema.Schema.Type<typeof NotifyRecord>;

/** One downloadable file: the item itself, or one recorded Sidecar child. */
const ChildDownload = Schema.Union(
  Schema.Struct({ status: Schema.Literal('pending') }),
  /** Written before the browser is asked, so an interruption can be reconciled. */
  Schema.Struct({
    status: Schema.Literal('starting'),
    at: EpochMillis,
    filenameDigest: Schema.String.pipe(Schema.pattern(/^[a-f0-9]{64}$/)),
  }),
  Schema.Struct({
    status: Schema.Literal('accepted'),
    at: EpochMillis,
    downloadId: Schema.optional(EpochMillis),
    historySaved: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    status: Schema.Literal('failed'),
    code: FailureCodeSchema,
    at: EpochMillis,
    dismissed: Schema.optional(Schema.Boolean),
    notificationAttempted: Schema.optional(Schema.Literal(true)),
  }),
  Schema.Struct({ status: Schema.Literal('uncertain'), at: EpochMillis }),
  /** The person said they have the file after an uncertain interruption. */
  Schema.Struct({ status: Schema.Literal('confirmed'), at: EpochMillis })
);
export type ChildDownload = Schema.Schema.Type<typeof ChildDownload>;

const DownloadRecord = Schema.Struct({
  children: Schema.Array(ChildDownload).pipe(Schema.minItems(1)),
  dismissed: Schema.Boolean,
});
type DownloadRecord = Schema.Schema.Type<typeof DownloadRecord>;

const CollectRecord = Schema.Union(
  Schema.Struct({ at: EpochMillis, removedAt: Schema.optional(EpochMillis) }),
  Schema.Struct({ status: Schema.Literal('pending') }),
  Schema.Struct({
    status: Schema.Literal('failed'),
    at: EpochMillis,
    code: Schema.Literal('WATCH_STORE_FAILED', 'WATCH_STORE_CAPACITY_EXCEEDED'),
    dismissed: Schema.Boolean,
    notificationAttempted: Schema.optional(Schema.Literal(true)),
  })
);

const ManualExportPlan = Schema.Struct({
  id: Schema.UUID,
  children: Schema.Array(
    Schema.Struct({
      operationId: Schema.UUID,
      requested: ExportSettings,
      recovery: Schema.optional(Schema.Literal('original', 'reencode')),
      state: Schema.Literal('pending', 'starting', 'accepted', 'failed', 'skipped', 'excluded'),
      code: Schema.optional(
        Schema.Union(FailureCodeSchema, Schema.Literal('SILENT_REENCODE_DECLINED'))
      ),
      historySaved: Schema.optional(Schema.Boolean),
    })
  ),
});
export type ManualExportPlan = Schema.Schema.Type<typeof ManualExportPlan>;

const Discovery = Schema.Struct({
  id: Schema.UUID,
  /** The Watch check that found it, so one notification can summarize a check. */
  checkId: Schema.UUID,
  ref: MediaRef,
  discoveredAt: EpochMillis,
  /** Set once a supported response shows the exact item is gone. Final; never replaced. */
  unavailable: Schema.optional(
    Schema.Literal(
      'WATCH_STORY_EXPIRED',
      'WATCH_AVATAR_CHANGED',
      'WATCH_INSTANT_NOT_IN_FEED',
      'WATCH_MEDIA_UNAVAILABLE'
    )
  ),
  /** Recorded Sidecar children a supported response no longer returns. */
  missingChildren: Schema.optional(Schema.Array(MediaId)),
  notify: Schema.optional(NotifyRecord),
  download: Schema.optional(DownloadRecord),
  collect: Schema.optional(CollectRecord),
  manualExport: Schema.optional(ManualExportPlan),
});
export type Discovery = Schema.Schema.Type<typeof Discovery>;

const Watch = Schema.Struct({
  /** Lifecycle identity. Re-adding a deleted Watch creates a new one. */
  id: Schema.UUID,
  viewerId: AccountId,
  targetId: AccountId,
  /** The current username, accepted only from a response that matched `targetId`. */
  username: InstagramUsername,
  formerUsername: Schema.optional(InstagramUsername),
  createdAt: EpochMillis,
  enabled: Schema.Boolean,
  kinds: WatchKinds,
  actions: WatchActions,
  tracking: Tracking,
  discoveries: Schema.Array(Discovery),
  avatarImage: Schema.optional(AvatarImage),
  avatarLookupAt: Schema.optional(EpochMillis),
});
export type Watch = Schema.Schema.Type<typeof Watch>;

export const WatchStore = Schema.Struct({
  version: Schema.Literal(STORE_VERSION),
  watches: Schema.Array(Watch),
});
export type WatchStore = Schema.Schema.Type<typeof WatchStore>;
