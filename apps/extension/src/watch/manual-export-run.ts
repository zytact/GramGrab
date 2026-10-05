import { Effect, Either, Schema } from 'effect';
import {
  DirectExport,
  InboxExportOutcome,
  Export,
  ExportOperation,
  HumanItemNumber,
  InstantsExport,
  MediaIdentity,
  OperationId,
  SilentExport,
  type FailureCode,
  type ExportResult,
  type ExportSettings,
  type WatchCommand,
} from '@gramgrab/protocol';
import { browser } from '../lib/browser.ts';
import { normalizeBrowserDownloadFailure, normalizeSourceFailure } from '../errors/normalize.ts';
import { acceptedHistoryEntry } from '../history/receipt.ts';
import { appendHistory } from '../history/repository.ts';
import type { MediaItem } from '../instagram/normalize.ts';
import type { Discovery, ManualExportPlan, Watch } from './contracts.ts';
import {
  exportAuthorization,
  historyOrigin,
  learnedAvailability,
  originalFilename,
  reacquire,
  type Slot,
} from './export.ts';
import {
  claimChild,
  InboxExportExecution,
  planOutcome,
  requestedPlan,
  savePlan,
  saveChild,
} from './manual-export.ts';

type Child = ManualExportPlan['children'][number];
type Delivery =
  | { _tag: 'accepted'; historySaved: boolean }
  | { _tag: 'failed'; code: FailureCode; missing?: string }
  | { _tag: 'skipped' };

const deliveredSettings = (child: Child) => {
  if (child.recovery === 'original') return { mode: DirectExport.make() };
  if (child.recovery === 'reencode' && child.requested.mode._tag === 'SilentExport')
    return { ...child.requested, mode: SilentExport.make({ reencode: 'allow' }) };
  return child.requested;
};

async function deliverOriginal(
  watch: Watch,
  discovery: Discovery,
  item: MediaItem,
  index: number,
  child: Child
): Promise<Delivery> {
  const filename = originalFilename(item, index);
  try {
    await browser.downloads.download({ url: item.url, filename, saveAs: false });
  } catch (cause) {
    return { _tag: 'failed', code: normalizeBrowserDownloadFailure(cause).code };
  }
  const historySaved = await appendHistory(
    acceptedHistoryEntry(
      {
        itemIndex: index,
        ...(item.mediaId ? { mediaId: item.mediaId } : {}),
        mediaType: item.type,
        filename,
        exportMode: 'direct',
        requestedExport: child.requested,
        ...(child.recovery ? { recovery: child.recovery } : {}),
      },
      historyOrigin(watch, discovery.ref)
    )
  ).then(
    () => true,
    () => false
  );
  return { _tag: 'accepted', historySaved };
}

function processingRequest(
  watch: Watch,
  discovery: Discovery,
  item: MediaItem,
  index: number,
  child: Child,
  settings: ExportSettings
) {
  const origin = historyOrigin(watch, discovery.ref);
  const sourceUrl = origin.kind === 'source' ? origin.sourceUrl : '';
  const operation = ExportOperation.make({
    operationId: Schema.decodeUnknownSync(OperationId)(child.operationId),
    itemNumber: Schema.decodeUnknownSync(HumanItemNumber)(index + 1),
    mediaIdentity: MediaIdentity.make({
      itemIndex: Schema.decodeUnknownSync(MediaIdentity.fields.itemIndex)(index),
      ...(item.mediaId ? { mediaId: item.mediaId } : {}),
    }),
    mode: settings.mode,
    ...(settings.rotation ? { rotation: settings.rotation } : {}),
  });
  return {
    sourceUrl,
    originKind: origin.kind,
    command:
      origin.kind === 'instants'
        ? InstantsExport.make({ operations: [operation] })
        : Export.make({ sourceUrl, operations: [operation] }),
    preparedMedia: [{ ...item, itemIndex: index }],
    requestedExport: child.requested,
    ...(child.recovery ? { recovery: child.recovery } : {}),
  };
}

function processingDelivery(result: ExportResult, operationId: string): Delivery {
  const matches = result.outcomes.filter(outcome => outcome.operationId === operationId);
  const [outcome] = matches;
  if (matches.length !== 1 || !outcome)
    return { _tag: 'failed', code: 'DOWNLOAD_UNEXPECTED_FAILURE' };
  if (outcome._tag === 'ItemSucceeded') return { _tag: 'accepted', historySaved: !outcome.warning };
  if (outcome._tag === 'ItemSkipped') return { _tag: 'skipped' };
  return { _tag: 'failed', code: outcome.failure.code };
}

const deliver = Effect.fn(function* (
  watch: Watch,
  discovery: Discovery,
  item: MediaItem,
  index: number,
  child: Child
) {
  const settings = deliveredSettings(child);
  if (settings.mode._tag === 'DirectExport' && !settings.rotation)
    return yield* Effect.promise(() => deliverOriginal(watch, discovery, item, index, child));
  const execution = yield* InboxExportExecution;
  return yield* Effect.tryPromise({
    try: () => execution.run(processingRequest(watch, discovery, item, index, child, settings)),
    catch: () => 'DOWNLOAD_UNEXPECTED_FAILURE' as const,
  }).pipe(
    Effect.match({
      onFailure: code => ({ _tag: 'failed', code }) satisfies Delivery,
      onSuccess: result => processingDelivery(result, child.operationId),
    })
  );
});

const failureChild = (child: Child, code: FailureCode): Child => ({
  ...child,
  state: 'failed',
  code,
});
const settledChild = (child: Child, delivery: Delivery): Child =>
  delivery._tag === 'accepted'
    ? { ...child, state: 'accepted', historySaved: delivery.historySaved }
    : delivery._tag === 'skipped'
      ? { ...child, state: 'skipped', code: 'SILENT_REENCODE_DECLINED' }
      : failureChild(child, delivery.code);

const failPlan = Effect.fn(function* (
  watch: Watch,
  discovery: Discovery,
  plan: ManualExportPlan,
  code: FailureCode
) {
  for (const [index, child] of plan.children.entries()) {
    if (child.state !== 'pending') continue;
    const next = failureChild(child, code);
    yield* Effect.promise(() => saveChild(watch, discovery.id, plan.id, index, next, 'pending'));
    plan = {
      ...plan,
      children: plan.children.map((existing, position) => (position === index ? next : existing)),
    };
  }
  return {
    outcome: planOutcome(discovery.id, plan, discovery.ref._tag === 'Sidecar', code),
    learned: undefined,
  };
});

const settle = Effect.fn(function* (
  watch: Watch,
  discovery: Discovery,
  plan: ManualExportPlan,
  index: number,
  slot: Slot
) {
  const child = plan.children[index]!;
  const ref = discovery.ref;
  const recorded = ref._tag === 'Sidecar' ? ref.children[index] : undefined;
  if (recorded && discovery.missingChildren?.includes(recorded.mediaId))
    return { _tag: 'failed', code: 'WATCH_MEDIA_UNAVAILABLE' } satisfies Delivery;
  if (slot._tag === 'gone')
    return {
      _tag: 'failed',
      code: slot.code,
      ...(recorded ? { missing: recorded.mediaId } : {}),
    } satisfies Delivery;
  const authorization = yield* exportAuthorization(watch, discovery);
  if (authorization) return { _tag: 'failed', code: authorization } satisfies Delivery;
  const code = yield* claimChild(watch, discovery.id, plan, index);
  if (code) return { _tag: 'failed', code } satisfies Delivery;
  return yield* deliver(watch, discovery, slot.item, index, child);
});

const persistDelivery = Effect.fn(function* (
  watch: Watch,
  discovery: Discovery,
  plan: ManualExportPlan,
  index: number,
  next: Child
) {
  const result = yield* Effect.promise(() =>
    saveChild(watch, discovery.id, plan.id, index, next, 'starting')
  );
  if (result.kind === 'ok' && !result.value)
    yield* Effect.promise(() => saveChild(watch, discovery.id, plan.id, index, next, 'pending'));
});

const exportEntry = Effect.fn(function* (
  watch: Watch,
  discovery: Discovery,
  initial: ManualExportPlan
) {
  if (discovery.unavailable)
    return yield* failPlan(watch, discovery, initial, discovery.unavailable);
  const slots = yield* Effect.either(
    reacquire(watch, discovery.ref, Math.floor(Date.now() / 1000))
  );
  if (Either.isLeft(slots))
    return yield* failPlan(
      watch,
      discovery,
      initial,
      slots.left._tag === 'WatchRequestDeferred'
        ? 'SOURCE_UNEXPECTED_FAILURE'
        : normalizeSourceFailure(slots.left).code
    );
  let plan = initial;
  const missing: string[] = [];
  for (const [index, child] of plan.children.entries()) {
    if (child.state !== 'pending') continue;
    const slot = slots.right[index];
    const delivery: Delivery = slot
      ? yield* settle(watch, discovery, plan, index, slot)
      : { _tag: 'failed', code: 'IG_RESPONSE_SHAPE_UNKNOWN' };
    const next = settledChild(child, delivery);
    yield* persistDelivery(watch, discovery, plan, index, next);
    plan = {
      ...plan,
      children: plan.children.map((existing, position) => (position === index ? next : existing)),
    };
    if (delivery._tag === 'failed' && delivery.missing) missing.push(delivery.missing);
  }
  return {
    outcome: planOutcome(discovery.id, plan, discovery.ref._tag === 'Sidecar'),
    learned: learnedAvailability(discovery, missing, slots.right),
  };
});

export const exportPlannedEntry = Effect.fn(function* (
  watch: Watch,
  discovery: Discovery,
  command: Extract<WatchCommand, { _tag: 'WatchInboxExport' | 'WatchInboxRetry' }>
) {
  const plan = requestedPlan(discovery, command);
  const write = plan ? yield* Effect.promise(() => savePlan(watch, discovery, plan)) : undefined;
  if (!plan || write?.kind !== 'ok' || !write.value)
    return {
      outcome: InboxExportOutcome.make({
        entryId: discovery.id,
        accepted: 0,
        failures: [
          { code: write?.kind === 'failed' ? write.code : 'WATCH_RECOVERY_NOT_APPLICABLE' },
        ],
      }),
      learned: undefined,
    };
  return yield* exportEntry(watch, discovery, plan);
});
