import { Schema } from 'effect';
import {
  ExportSettings,
  AccountId,
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
/** Instagram's opaque picture/upload identity for an Avatar. */
export const PictureId = Schema.String.pipe(Schema.pattern(/^[0-9A-Za-z_:-]{1,128}$/));
export const Shortcode = Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9_-]{1,64}$/));
const MediaType = Schema.Literal('image', 'video');

export const STORE_KEY = 'watch-store';
export const STORE_VERSION = 1;
export const STORE_BUDGET_BYTES = 2 * 1024 * 1024;
/** Inbox entries and the discoveries behind them last this long after discovery. */
export const RETENTION_MS = 30 * 24 * 60 * 60_000;

const KindProblemRecord = Schema.Struct({ code: FailureCodeSchema, at: EpochMillis });

const TimedTracking = Schema.Struct({
  /** Publication second at or before which media is part of the baseline. Absent means pending. */
  baselineCutoff: Schema.optional(EpochSeconds),
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

const MediaRef = Schema.Union(PostRef, SidecarRef, StoryRef, InstantRef, AvatarRef);
export type MediaRef = Schema.Schema.Type<typeof MediaRef>;
/** A reference to media with a publication time, which every kind but Avatar records. */
export type TimedRef = Exclude<MediaRef, { readonly _tag: 'Avatar' }>;

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
      state: Schema.Literal('pending', 'starting', 'accepted', 'failed', 'skipped'),
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
});
export type Watch = Schema.Schema.Type<typeof Watch>;

export const WatchStore = Schema.Struct({
  version: Schema.Literal(STORE_VERSION),
  watches: Schema.Array(Watch),
});
export type WatchStore = Schema.Schema.Type<typeof WatchStore>;
