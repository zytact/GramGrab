import { Effect, Layer, Schema } from 'effect';
import {
  ExportResult,
  ItemFailed,
  ItemSkipped,
  ItemSucceeded,
  InternalItemIndex,
  MediaIdentity,
  OperationFailure as ProtocolOperationFailure,
  type ExportOperation,
  type ItemOutcome,
  type MediaItem,
} from '@gramgrab/protocol';
import { browser } from './lib/browser.ts';
import { decodeMessage, type MessageOf } from './messaging/contracts.ts';
import { notify, sendMessage } from './messaging/send.ts';
import {
  createRequestId,
  type DownloadOperation,
  type DownloadOperationResult,
} from './download/contracts.ts';
import {
  executeExportPlan,
  ExportEvents,
  ExportExecution,
  ExportPlan,
} from './download/coordinator.ts';
import type { AttemptOperation } from './download/attempt.ts';
import { executeFrameExport } from './frame-export/executor.ts';
import { runSilentVideoBatch } from './silent-video/batch.ts';
import { approvedReencodeOperationIds } from './silent-video/policy.ts';

type RunnerRequest = MessageOf<'RUN_EXPORT'>;

export function resolveRequestedRunnerMedia(
  media: readonly MediaItem[],
  requested: ExportOperation
): MediaItem | undefined {
  const mediaId = requested.mediaIdentity?.mediaId;
  if (mediaId) {
    const matches = media.filter(item => item.mediaId === mediaId);
    return matches.length === 1 ? matches[0] : undefined;
  }
  const item = media[requested.itemNumber - 1];
  if (requested.mediaIdentity && requested.mediaIdentity.itemIndex !== item?.itemIndex)
    return undefined;
  return item;
}

// fallow-ignore-next-line complexity
function toOutcome(operation: ExportOperation, result: DownloadOperationResult): ItemOutcome {
  const mediaIdentity = MediaIdentity.make({
    itemIndex:
      operation.mediaIdentity?.itemIndex ??
      Schema.decodeUnknownSync(InternalItemIndex)(operation.itemNumber - 1),
    ...(operation.mediaIdentity?.mediaId ? { mediaId: operation.mediaIdentity.mediaId } : {}),
  });
  if (result.status === 'started')
    return ItemSucceeded.make({
      operationId: operation.operationId,
      itemNumber: operation.itemNumber,
      mediaIdentity,
    });
  if (result.status === 'skipped')
    return ItemSkipped.make({
      operationId: operation.operationId,
      itemNumber: operation.itemNumber,
      code: 'SILENT_REENCODE_DECLINED',
    });
  const failure =
    result.status === 'failed'
      ? ProtocolOperationFailure.make({
          code: result.failure.code,
          scope: result.failure.scope,
        })
      : ProtocolOperationFailure.make({
          code: 'DOWNLOAD_UNEXPECTED_FAILURE',
          scope: 'item',
        });
  return ItemFailed.make({
    operationId: operation.operationId,
    itemNumber: operation.itemNumber,
    mediaIdentity,
    failure,
  });
}

// fallow-ignore-next-line complexity
async function run({ sourceUrl, originKind, command }: RunnerRequest): Promise<ExportResult> {
  const inspected = await (originKind === 'instants'
    ? sendMessage({ type: 'FETCH_INSTANTS' })
    : sendMessage({ type: 'FETCH_MEDIA', url: sourceUrl }));
  const operations: AttemptOperation[] = [];
  const invalid: ItemOutcome[] = [];
  const requestedById = new Map<string, ExportOperation>();
  const approved = new Set<string>();
  const required = new Set<string>();
  for (const requested of command.operations) {
    const item = resolveRequestedRunnerMedia(inspected.media ?? [], requested);
    if (!item) {
      invalid.push(
        ItemFailed.make({
          operationId: requested.operationId,
          itemNumber: requested.itemNumber,
          failure: ProtocolOperationFailure.make({ code: 'MEDIA_NOT_FOUND', scope: 'item' }),
        })
      );
      continue;
    }
    const mode =
      requested.mode._tag === 'DirectExport'
        ? 'direct'
        : requested.mode._tag === 'FrameExport'
          ? 'frame'
          : 'silent';
    if (requested.mode._tag === 'SilentExport' && requested.mode.reencode === 'require')
      required.add(requested.operationId);
    const extension = item.type === 'video' ? 'mp4' : 'jpg';
    const suffix =
      mode === 'silent' ? '_silent.mp4' : mode === 'frame' ? '_frame.jpg' : `.${extension}`;
    operations.push({
      operationId: requested.operationId,
      requestId: createRequestId(),
      itemIndex: item.itemIndex,
      ...(item.mediaId ? { mediaId: item.mediaId } : {}),
      url: item.url,
      filename: `${item.filenameHint}_${item.itemIndex + 1}${suffix}`,
      mediaType: item.type,
      originalUrl: item.url,
      originalFilename: `${item.filenameHint}_${item.itemIndex + 1}.${extension}`,
      mode,
      displayIndex: item.itemIndex,
      ...(requested.mode._tag === 'FrameExport'
        ? { frameTimestampSeconds: requested.mode.timestampSeconds }
        : {}),
    });
    requestedById.set(requested.operationId, requested);
  }
  const results: DownloadOperationResult[] = [];
  const execution = Layer.succeed(ExportExecution, {
    frame: operation =>
      executeFrameExport(operation, sourceUrl, {
        originKind,
        onPhase: phase =>
          notify({
            type: 'RUNNER_PROGRESS',
            operationId: operation.operationId,
            itemNumber: requestedById.get(operation.operationId)?.itemNumber,
            phase,
          }),
      }),
    direct: (direct: readonly DownloadOperation[]) => {
      for (const operation of direct)
        notify({
          type: 'RUNNER_PROGRESS',
          operationId: operation.operationId,
          itemNumber: requestedById.get(operation.operationId)?.itemNumber,
          phase: 'direct-download',
        });
      return sendMessage({
        type: 'DOWNLOAD_MEDIA',
        ...(originKind === 'source' ? { sourceUrl } : {}),
        originKind,
        operations: direct,
      });
    },
    silent: (silent, progress, preflight, approvedIds) =>
      runSilentVideoBatch(
        silent,
        candidates => Promise.resolve(approvedReencodeOperationIds(candidates, requestedById)),
        progress,
        sourceUrl,
        () => {
          for (const operationId of required) approvedIds.add(operationId);
          preflight();
        },
        approvedIds,
        originKind
      ),
  });
  const events = Layer.succeed(ExportEvents, {
    progress: (requestId, phase, progress) => {
      const operation = operations.find(candidate => candidate.requestId === requestId);
      const requested = operation && requestedById.get(operation.operationId);
      notify({
        type: 'RUNNER_PROGRESS',
        ...(requested
          ? { operationId: requested.operationId, itemNumber: requested.itemNumber }
          : {}),
        phase,
        progress,
      });
    },
    settle: settled => results.push(...settled),
  });
  if (operations.length > 0)
    await Effect.runPromise(
      executeExportPlan(ExportPlan.make({ operations }), approved).pipe(
        Effect.provide(Layer.merge(execution, events))
      )
    );
  return ExportResult.make({
    outcomes: [
      ...invalid,
      ...results.flatMap(result => {
        const requested = requestedById.get(result.operationId);
        return requested ? [toOutcome(requested, result)] : [];
      }),
    ],
  });
}

browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const decoded = decodeMessage(message);
  if (decoded.kind !== 'message' || decoded.message.type !== 'RUN_EXPORT') return false;
  void run(decoded.message).then(sendResponse);
  return true;
});

notify({ type: 'RUNNER_READY' });
