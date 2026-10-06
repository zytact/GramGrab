import { Schema } from 'effect';
import { FailureCodeSchema } from './failures.ts';
import { ExportSettings } from './export-modes.ts';

const NonEmptyString = Schema.String.pipe(Schema.nonEmptyString());
const EpochMillis = Schema.Number.pipe(Schema.int(), Schema.nonNegative());
const Count = Schema.Number.pipe(Schema.int(), Schema.nonNegative());

/** Display order. Checks run Stories, Instants, Avatar, then Posts. */
export const WATCH_KINDS = ['posts', 'stories', 'instants', 'avatar'] as const;
export const WatchKind = Schema.Literal(...WATCH_KINDS);
export type WatchKind = Schema.Schema.Type<typeof WatchKind>;

export const WATCH_ACTIONS = ['notify', 'download', 'collect'] as const;
export const WatchAction = Schema.Literal(...WATCH_ACTIONS);
export type WatchAction = Schema.Schema.Type<typeof WatchAction>;

/** A numeric Instagram account ID, kept as its exact decimal string. */
export const AccountId = Schema.String.pipe(Schema.pattern(/^[1-9]\d{0,24}$/));
export const InstagramUsername = Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9._]{1,30}$/));

const uniqueNonEmpty = <A extends string, I extends string>(item: Schema.Schema<A, I>) =>
  Schema.Array(item).pipe(
    Schema.minItems(1),
    Schema.filter(items => new Set(items).size === items.length, {
      message: () => 'must not repeat a value',
    })
  );

export const WatchKinds = uniqueNonEmpty(WatchKind);
export const WatchActions = uniqueNonEmpty(WatchAction);

export class AccountIdSelector extends Schema.TaggedClass<AccountIdSelector>()(
  'AccountIdSelector',
  { accountId: AccountId }
) {}

export class UsernameSelector extends Schema.TaggedClass<UsernameSelector>()('UsernameSelector', {
  username: InstagramUsername,
}) {}

/** Picks one of the verified login's Watches. It never matches another login's Watch. */
export const WatchSelector = Schema.Union(AccountIdSelector, UsernameSelector);
export type WatchSelector = Schema.Schema.Type<typeof WatchSelector>;

export class WatchList extends Schema.TaggedClass<WatchList>()('WatchList', {}) {}

export class WatchNeeds extends Schema.TaggedClass<WatchNeeds>()('WatchNeeds', {}) {}

export const AttentionOperation = Schema.Literal('retry', 'dismiss', 'confirm');
export type AttentionOperation = Schema.Schema.Type<typeof AttentionOperation>;

export class WatchAttentionRecover extends Schema.TaggedClass<WatchAttentionRecover>()(
  'WatchAttentionRecover',
  {
    operation: AttentionOperation,
    attentionIds: Schema.Array(NonEmptyString).pipe(Schema.minItems(1)),
  }
) {}

export class WatchShow extends Schema.TaggedClass<WatchShow>()('WatchShow', {
  watch: WatchSelector,
}) {}

export class WatchAdd extends Schema.TaggedClass<WatchAdd>()('WatchAdd', {
  target: NonEmptyString,
  kinds: WatchKinds,
  actions: WatchActions,
  acceptUnattended: Schema.Boolean,
}) {}

export class WatchSet extends Schema.TaggedClass<WatchSet>()('WatchSet', {
  watch: WatchSelector,
  kinds: Schema.optional(WatchKinds),
  actions: Schema.optional(WatchActions),
}) {}

export class WatchLifecycle extends Schema.TaggedClass<WatchLifecycle>()('WatchLifecycle', {
  operation: Schema.Literal('pause', 'resume', 'delete'),
  watches: Schema.Array(WatchSelector).pipe(Schema.minItems(1)),
}) {}

/** Checks the selected Watches now, or every enabled Watch of the login when none are given. */
export class WatchCheck extends Schema.TaggedClass<WatchCheck>()('WatchCheck', {
  watches: Schema.optional(Schema.Array(WatchSelector).pipe(Schema.minItems(1))),
}) {}

export class WatchInboxList extends Schema.TaggedClass<WatchInboxList>()('WatchInboxList', {
  watch: Schema.optional(WatchSelector),
}) {}

export class WatchInboxRemove extends Schema.TaggedClass<WatchInboxRemove>()('WatchInboxRemove', {
  entryIds: Schema.Array(NonEmptyString).pipe(Schema.minItems(1)),
}) {}

/** Downloads the exact recorded media of each inbox entry with a frozen Export plan. */
export class WatchInboxExport extends Schema.TaggedClass<WatchInboxExport>()('WatchInboxExport', {
  entryIds: Schema.Array(NonEmptyString).pipe(Schema.minItems(1)),
  settings: Schema.optional(ExportSettings),
}) {}

export class WatchInboxRetry extends Schema.TaggedClass<WatchInboxRetry>()('WatchInboxRetry', {
  plans: Schema.Array(Schema.Struct({ entryId: NonEmptyString, planId: Schema.UUID })).pipe(
    Schema.minItems(1)
  ),
  recovery: Schema.optional(Schema.Literal('original', 'reencode')),
}) {}

/** Retries or dismisses a failed action of each entry; other entries cannot be recovered so. */
export class WatchRecover extends Schema.TaggedClass<WatchRecover>()('WatchRecover', {
  action: Schema.Literal('notify', 'download', 'collect'),
  operation: Schema.Literal('retry', 'dismiss', 'confirm', 'download-again'),
  entryIds: Schema.Array(NonEmptyString).pipe(Schema.minItems(1)),
  child: Schema.optional(Count),
}) {}

export const WatchCommand = Schema.Union(
  WatchList,
  WatchNeeds,
  WatchAttentionRecover,
  WatchShow,
  WatchAdd,
  WatchSet,
  WatchLifecycle,
  WatchCheck,
  WatchInboxList,
  WatchInboxRemove,
  WatchInboxExport,
  WatchInboxRetry,
  WatchRecover
);
export type WatchCommand = Schema.Schema.Type<typeof WatchCommand>;

export class WatchViewer extends Schema.Class<WatchViewer>('WatchViewer')({
  accountId: AccountId,
  username: InstagramUsername,
}) {}

export class KindBaselinePending extends Schema.TaggedClass<KindBaselinePending>()(
  'KindBaselinePending',
  { kind: WatchKind }
) {}

export class KindChecked extends Schema.TaggedClass<KindChecked>()('KindChecked', {
  kind: WatchKind,
  lastSuccessAt: EpochMillis,
  /** A longer Posts check is part way through and continues later this round. */
  catchingUp: Schema.optional(Schema.Literal(true)),
}) {}

/** A kind that is not selected. Its baseline, if it has one, is kept for when it comes back. */
export class KindOff extends Schema.TaggedClass<KindOff>()('KindOff', {
  kind: WatchKind,
  baselineKept: Schema.Boolean,
}) {}

export class KindProblem extends Schema.TaggedClass<KindProblem>()('KindProblem', {
  kind: WatchKind,
  code: FailureCodeSchema,
  since: EpochMillis,
  lastSuccessAt: Schema.optional(EpochMillis),
}) {}

export const KindHealth = Schema.Union(KindBaselinePending, KindChecked, KindOff, KindProblem);
export type KindHealth = Schema.Schema.Type<typeof KindHealth>;

export class KindBaselineRecorded extends Schema.TaggedClass<KindBaselineRecorded>()(
  'KindBaselineRecorded',
  { kind: WatchKind }
) {}

export class KindCheckSucceeded extends Schema.TaggedClass<KindCheckSucceeded>()(
  'KindCheckSucceeded',
  {
    kind: WatchKind,
    newCount: Count,
    /** A longer traversal continues on a later turn of the same round. */
    catchUp: Schema.Boolean,
  }
) {}

export class KindCheckFailed extends Schema.TaggedClass<KindCheckFailed>()('KindCheckFailed', {
  kind: WatchKind,
  code: FailureCodeSchema,
}) {}

export class KindCheckSkipped extends Schema.TaggedClass<KindCheckSkipped>()('KindCheckSkipped', {
  kind: WatchKind,
  reason: Schema.Literal('paused', 'kind-off', 'login-unverified', 'storage', 'deferred'),
}) {}

export const KindCheckOutcome = Schema.Union(
  KindBaselineRecorded,
  KindCheckSucceeded,
  KindCheckFailed,
  KindCheckSkipped
);
export type KindCheckOutcome = Schema.Schema.Type<typeof KindCheckOutcome>;

/** A Check now the worker has queued or is running, with each kind it has finished so far. */
export class ManualCheckPending extends Schema.TaggedClass<ManualCheckPending>()(
  'ManualCheckPending',
  { remainingKinds: Schema.Array(WatchKind), outcomes: Schema.Array(KindCheckOutcome) }
) {}

/** The Watch's last finished Check now and what each kind found. */
export class ManualCheckFinished extends Schema.TaggedClass<ManualCheckFinished>()(
  'ManualCheckFinished',
  { finishedAt: EpochMillis, outcomes: Schema.Array(KindCheckOutcome) }
) {}

export const ManualCheck = Schema.Union(ManualCheckPending, ManualCheckFinished);
export type ManualCheck = Schema.Schema.Type<typeof ManualCheck>;

export class WatchSummary extends Schema.Class<WatchSummary>('WatchSummary')({
  watchId: NonEmptyString,
  accountId: AccountId,
  username: InstagramUsername,
  formerUsername: Schema.optional(InstagramUsername),
  enabled: Schema.Boolean,
  kinds: Schema.Array(KindHealth),
  actions: Schema.Array(WatchAction),
  attentionCount: Count,
  inboxCount: Count,
  createdAt: EpochMillis,
  lastCheckAt: Schema.optional(EpochMillis),
  manualCheck: Schema.optional(ManualCheck),
}) {}

export class WatchStorage extends Schema.Class<WatchStorage>('WatchStorage')({
  usedBytes: Count,
  budgetBytes: Count,
  status: Schema.Literal('ok', 'full', 'write-failed', 'unreadable', 'unsupported'),
}) {}

/** When unattended checks run next for the verified login, and what holds them back. */
export class WatchSchedule extends Schema.Class<WatchSchedule>('WatchSchedule')({
  nextRoundAt: Schema.optional(EpochMillis),
  /** Watches still waiting for their turn in the current round. */
  roundRemaining: Count,
  /** Instagram rate limited a request; no Watch request starts before this time. */
  pausedUntil: Schema.optional(EpochMillis),
  /** Instagram rejected the session; checks wait until the person acts. */
  suspended: Schema.Boolean,
}) {}

/** Where one selected action stands for a discovery. */
export class ActionOutcome extends Schema.Class<ActionOutcome>('ActionOutcome')({
  state: Schema.Literal('waiting', 'done', 'failed', 'unconfirmed'),
  code: Schema.optional(FailureCodeSchema),
  dismissed: Schema.optional(Schema.Boolean),
}) {}

/** One discovery as the page and CLI show it: no media bytes, URLs, or captions. */
/**
 * One entry's Export: how many files the browser accepted, and each failure, with the 0-based
 * Sidecar child it concerns when it concerns one.
 */
export class InboxExportOutcome extends Schema.Class<InboxExportOutcome>('InboxExportOutcome')({
  entryId: NonEmptyString,
  planId: Schema.optional(Schema.UUID),
  accepted: Count,
  skipped: Schema.optional(
    Schema.Array(
      Schema.Struct({
        child: Schema.optional(Count),
        code: Schema.Literal('SILENT_REENCODE_DECLINED'),
      })
    )
  ),
  failures: Schema.Array(Schema.Struct({ child: Schema.optional(Count), code: FailureCodeSchema })),
  /** An accepted file's History receipt could not be saved. */
  warning: Schema.optional(Schema.Literal('HISTORY_SAVE_FAILED')),
}) {}

export class DiscoverySummary extends Schema.Class<DiscoverySummary>('DiscoverySummary')({
  entryId: NonEmptyString,
  manualExport: Schema.optional(InboxExportOutcome),
  watchId: NonEmptyString,
  accountId: AccountId,
  username: InstagramUsername,
  kind: WatchKind,
  mediaType: Schema.Literal('image', 'video', 'sidecar', 'avatar'),
  childCount: Schema.optional(Count),
  discoveredAt: EpochMillis,
  /** When the entry leaves the inbox; absent when it was never collected or was removed. */
  inboxUntil: Schema.optional(EpochMillis),
  remainingRetentionMs: Schema.optional(Count),
  unavailable: Schema.optional(FailureCodeSchema),
  missingChildren: Schema.optional(Count),
  notify: Schema.optional(ActionOutcome),
  download: Schema.optional(ActionOutcome),
  downloadChildren: Schema.optional(Schema.Array(ActionOutcome)),
  collect: Schema.optional(ActionOutcome),
}) {}

export class WatchListResult extends Schema.TaggedClass<WatchListResult>()('WatchListResult', {
  viewer: WatchViewer,
  schedule: WatchSchedule,
  otherLoginWatchCount: Count,
  storage: WatchStorage,
  attentionCount: Count,
  watches: Schema.Array(WatchSummary),
  /** Discoveries with an action that needs the person: failed and not dismissed. */
  attentionEntries: Schema.Array(DiscoverySummary),
}) {}

export class WatchShowResult extends Schema.TaggedClass<WatchShowResult>()('WatchShowResult', {
  watch: WatchSummary,
  discoveries: Schema.Array(DiscoverySummary),
}) {}

export class CheckAttention extends Schema.TaggedClass<CheckAttention>()('CheckAttention', {
  attentionId: NonEmptyString,
  watchId: NonEmptyString,
  kind: WatchKind,
  code: FailureCodeSchema,
  since: EpochMillis,
  lastSuccessAt: Schema.optional(EpochMillis),
}) {}

export class ActionAttention extends Schema.TaggedClass<ActionAttention>()('ActionAttention', {
  attentionId: NonEmptyString,
  entryId: NonEmptyString,
  action: WatchAction,
  child: Schema.optional(Count),
  state: Schema.Literal('failed', 'unconfirmed'),
  code: Schema.optional(FailureCodeSchema),
  operations: Schema.Array(AttentionOperation),
}) {}

export class PauseAttention extends Schema.TaggedClass<PauseAttention>()('PauseAttention', {
  attentionId: NonEmptyString,
  until: EpochMillis,
  code: Schema.Literal('IG_RATE_LIMITED'),
}) {}

export class StorageAttention extends Schema.TaggedClass<StorageAttention>()('StorageAttention', {
  attentionId: NonEmptyString,
  code: Schema.Literal(
    'WATCH_STORE_CAPACITY_EXCEEDED',
    'WATCH_STORE_FAILED',
    'WATCH_STORE_UNREADABLE',
    'WATCH_STORE_VERSION_UNSUPPORTED'
  ),
}) {}

export const WatchAttention = Schema.Union(
  CheckAttention,
  ActionAttention,
  PauseAttention,
  StorageAttention
);
export type WatchAttention = Schema.Schema.Type<typeof WatchAttention>;

export class WatchNeedsResult extends Schema.TaggedClass<WatchNeedsResult>()('WatchNeedsResult', {
  items: Schema.Array(WatchAttention),
  watches: Schema.Array(WatchSummary),
  entries: Schema.Array(DiscoverySummary),
}) {}

export class RecoveryOutcome extends Schema.Class<RecoveryOutcome>('RecoveryOutcome')({
  entryId: NonEmptyString,
  state: Schema.Literal('recovered', 'failed', 'waiting', 'unconfirmed'),
  code: Schema.optional(FailureCodeSchema),
}) {}

export class WatchAttentionRecoverResult extends Schema.TaggedClass<WatchAttentionRecoverResult>()(
  'WatchAttentionRecoverResult',
  {
    recoveredAttentionIds: Schema.Array(NonEmptyString),
    refused: Schema.Array(
      Schema.Struct({
        attentionId: NonEmptyString,
        code: Schema.Literal('WATCH_RECOVERY_NOT_APPLICABLE'),
      })
    ),
    failures: Schema.Array(
      Schema.Struct({ attentionId: NonEmptyString, outcome: RecoveryOutcome })
    ),
    unknownAttentionIds: Schema.Array(NonEmptyString),
  }
) {}

export class WatchCheckProgress extends Schema.Class<WatchCheckProgress>('WatchCheckProgress')({
  watchId: Schema.UUID,
  kind: WatchKind,
  outcome: KindCheckOutcome,
}) {}

/**
 * Why a check was held back: the Watch was checked in the last 5 minutes, Watch requests are
 * spaced out, Instagram rate limited a Watch request, or a check of it is already queued.
 */
export const DeferredReason = Schema.Literal('checked-recently', 'paced', 'rate-limited', 'queued');
export type DeferredReason = Schema.Schema.Type<typeof DeferredReason>;

export class WatchCheckOutcome extends Schema.Class<WatchCheckOutcome>('WatchCheckOutcome')({
  watchId: NonEmptyString,
  accountId: AccountId,
  username: InstagramUsername,
  kinds: Schema.Array(KindCheckOutcome),
  /** Set when pacing held the check back: the earliest time it can run. */
  deferredUntil: Schema.optional(EpochMillis),
  deferredReason: Schema.optional(DeferredReason),
}) {}

export class WatchCheckResult extends Schema.TaggedClass<WatchCheckResult>()('WatchCheckResult', {
  outcomes: Schema.Array(WatchCheckOutcome),
  unknownWatches: Schema.Array(NonEmptyString),
}) {}

export class WatchInboxListResult extends Schema.TaggedClass<WatchInboxListResult>()(
  'WatchInboxListResult',
  { entries: Schema.Array(DiscoverySummary) }
) {}

export class WatchInboxRemoveResult extends Schema.TaggedClass<WatchInboxRemoveResult>()(
  'WatchInboxRemoveResult',
  {
    removedEntryIds: Schema.Array(NonEmptyString),
    unknownEntryIds: Schema.Array(NonEmptyString),
  }
) {}

export class WatchAddResult extends Schema.TaggedClass<WatchAddResult>()('WatchAddResult', {
  created: Schema.Boolean,
  watch: WatchSummary,
}) {}

export class WatchSetResult extends Schema.TaggedClass<WatchSetResult>()('WatchSetResult', {
  watch: WatchSummary,
  /** Newly selected kinds; each one's first check only records a baseline. */
  baselineKinds: Schema.Array(WatchKind),
}) {}

export class WatchLifecycleResult extends Schema.TaggedClass<WatchLifecycleResult>()(
  'WatchLifecycleResult',
  {
    operation: Schema.Literal('pause', 'resume', 'delete'),
    watches: Schema.Array(WatchSummary),
    unknownWatches: Schema.Array(NonEmptyString),
  }
) {}

export class WatchInboxExportResult extends Schema.TaggedClass<WatchInboxExportResult>()(
  'WatchInboxExportResult',
  {
    outcomes: Schema.Array(InboxExportOutcome),
    unknownEntryIds: Schema.Array(NonEmptyString),
  }
) {}

export class WatchRecoverResult extends Schema.TaggedClass<WatchRecoverResult>()(
  'WatchRecoverResult',
  {
    recoveredEntryIds: Schema.Array(NonEmptyString),
    outcomes: Schema.optional(Schema.Array(RecoveryOutcome)),
    refused: Schema.Array(
      Schema.Struct({
        entryId: NonEmptyString,
        code: Schema.Literal('WATCH_RECOVERY_NOT_APPLICABLE'),
      })
    ),
    unknownEntryIds: Schema.Array(NonEmptyString),
  }
) {}

export const WatchResult = Schema.Union(
  WatchListResult,
  WatchNeedsResult,
  WatchAttentionRecoverResult,
  WatchShowResult,
  WatchAddResult,
  WatchSetResult,
  WatchLifecycleResult,
  WatchCheckResult,
  WatchInboxListResult,
  WatchInboxRemoveResult,
  WatchInboxExportResult,
  WatchRecoverResult
);
export type WatchResult = Schema.Schema.Type<typeof WatchResult>;

/** Context that makes a Watch rejection actionable without exposing owner-bound state. */
export class StoredWatchCount extends Schema.TaggedClass<StoredWatchCount>()('StoredWatchCount', {
  count: Count,
}) {}

export class UnattendedDisclosure extends Schema.TaggedClass<UnattendedDisclosure>()(
  'UnattendedDisclosure',
  { text: NonEmptyString }
) {}

export class ExistingWatch extends Schema.TaggedClass<ExistingWatch>()('ExistingWatch', {
  accountId: AccountId,
  username: InstagramUsername,
}) {}

export const WatchFailureDetail = Schema.Union(
  StoredWatchCount,
  UnattendedDisclosure,
  ExistingWatch
);
export type WatchFailureDetail = Schema.Schema.Type<typeof WatchFailureDetail>;

/** The settled disclosure a person acknowledges every time they add a Watch. */
export const UNATTENDED_DISCLOSURE =
  'Watches check Instagram for you about twice a day while your browser is open, using your signed-in Instagram session, even when you are not using GramGrab. Instagram may treat this automated activity as unusual and could limit or flag your account. GramGrab stores only the account and media IDs and check results it needs, on this device, never media files or media links. You can pause or delete a Watch at any time.';
