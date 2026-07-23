import { Effect, Layer, Schema } from 'effect';
import {
  ExportResult,
  ItemFailed,
  ItemSkipped,
  ItemSucceeded,
  InternalItemIndex,
  MediaIdentity,
  OperationFailure as ProtocolOperationFailure,
  type Export,
  type ExportOperation,
  type ItemOutcome,
} from '@gramgrab/protocol';
import { browser } from './lib/browser.ts';
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

interface RunnerRequest {
  readonly type: 'RUN_EXPORT';
  readonly sourceUrl: string;
  readonly command: Export;
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
async function run({ sourceUrl, command }: RunnerRequest): Promise<ExportResult> {
  const inspected = (await browser.runtime.sendMessage({
    type: 'FETCH_MEDIA',
    url: sourceUrl,
  })) as {
    media?: readonly {
      url: string;
      itemIndex: number;
      mediaId?: string;
      type: 'image' | 'video';
      filenameHint: string;
    }[];
  };
  const operations: AttemptOperation[] = [];
  const invalid: ItemOutcome[] = [];
  const requestedById = new Map<string, ExportOperation>();
  const approved = new Set<string>();
  const required = new Set<string>();
  for (const requested of command.operations) {
    const item = inspected.media?.[requested.itemNumber - 1];
    if (
      !item ||
      (requested.mediaIdentity && requested.mediaIdentity.itemIndex !== item.itemIndex)
    ) {
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
        onPhase: phase =>
          void browser.runtime.sendMessage({
            type: 'RUNNER_PROGRESS',
            operationId: operation.operationId,
            itemNumber: requestedById.get(operation.operationId)?.itemNumber,
            phase,
          }),
      }),
    direct: (direct: readonly DownloadOperation[]) =>
      Promise.all(
        direct.map(operation =>
          browser.runtime.sendMessage({
            type: 'RUNNER_PROGRESS',
            operationId: operation.operationId,
            itemNumber: requestedById.get(operation.operationId)?.itemNumber,
            phase: 'direct-download',
          })
        )
      ).then(() =>
        browser.runtime.sendMessage({ type: 'DOWNLOAD_MEDIA', sourceUrl, operations: direct })
      ),
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
        approvedIds
      ),
  });
  const events = Layer.succeed(ExportEvents, {
    progress: (requestId, phase, progress) => {
      const operation = operations.find(candidate => candidate.requestId === requestId);
      const requested = operation && requestedById.get(operation.operationId);
      void browser.runtime.sendMessage({
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
  if ((message as { type?: string }).type !== 'RUN_EXPORT') return false;
  void run(message as RunnerRequest).then(sendResponse);
  return true;
});

void browser.runtime.sendMessage({ type: 'RUNNER_READY' });
