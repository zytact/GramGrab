import { browser } from '../lib/browser.ts';
import { sendMessage } from '../messaging/send.ts';
import {
  DownloadAcceptedResult,
  DownloadFailedResult,
  DownloadSkippedResult,
  DownloadNotAttemptedResult,
  OperationBatchOutcome,
  type DownloadOperationResult,
} from '../download/contracts.ts';
import {
  isOperationFailure,
  OperationFailure,
  OperationWarning,
  diagnosticCause,
  type InstagramFailureCode,
} from '../errors/contracts.ts';
import type { AttemptOperation } from '../download/attempt.ts';
import { SilentVideoClient } from './client.ts';
import { readOutput, sweepOutputs, transferOutputToDownload } from './opfs.ts';
import type { SilentPreflight } from './contracts.ts';

export interface ReencodeCandidate {
  readonly operation: AttemptOperation;
  readonly preflight: SilentPreflight;
}

interface OwnershipState {
  activeDownloads: number;
  batchComplete: boolean;
}

function silentFailure(
  cause: unknown,
  code: InstagramFailureCode,
  phase: OperationFailure['phase']
) {
  return isOperationFailure(cause)
    ? cause
    : OperationFailure.make({ code, phase, scope: 'item', cause: diagnosticCause(cause) });
}

async function inspectOperations(
  client: SilentVideoClient,
  operations: readonly AttemptOperation[],
  onProgress: (requestId: string, phase: string, progress: number) => void,
  approvedRequestIds: ReadonlySet<string>
) {
  const settled = operations.map<PromiseSettledResult<SilentPreflight> | undefined>(
    () => undefined
  );
  let nextIndex = 0;
  const inspectNext = async (): Promise<void> => {
    const index = nextIndex++;
    const operation = operations[index];
    if (!operation) return;
    try {
      settled[index] = {
        status: 'fulfilled',
        value: await client.inspect(
          operation.operationId,
          operation.requestId,
          operation.url,
          approvedRequestIds.has(operation.operationId),
          (phase, progress) => onProgress(operation.requestId, phase, progress)
        ),
      };
    } catch (reason) {
      settled[index] = { status: 'rejected', reason };
    }
    await inspectNext();
  };
  await Promise.all(Array.from({ length: Math.min(2, operations.length) }, inspectNext));
  const candidates: ReencodeCandidate[] = [];
  const failures: DownloadOperationResult[] = [];
  settled.forEach((result, index) => {
    const operation = operations[index];
    if (!operation || !result) return;
    if (result.status === 'fulfilled') candidates.push({ operation, preflight: result.value });
    else
      failures.push(
        DownloadFailedResult.make({
          operationId: operation.operationId,
          requestId: operation.requestId,
          status: 'failed',
          failure: silentFailure(
            result.reason,
            'SILENT_INPUT_INSPECTION_FAILED',
            'silent-inspection'
          ),
        })
      );
  });
  return { candidates, failures };
}

async function declinedReencodes(
  candidates: readonly ReencodeCandidate[],
  approvedRequestIds: Set<string>,
  approveReencode: (candidates: readonly ReencodeCandidate[]) => Promise<ReadonlySet<string>>
): Promise<Set<string>> {
  const undecided = candidates.filter(
    candidate =>
      candidate.preflight.audioTrackCount > 0 &&
      !candidate.preflight.copyCompatible &&
      !approvedRequestIds.has(candidate.operation.operationId)
  );
  if (undecided.length === 0) return new Set();
  const approved = await approveReencode(undecided);
  const declined = new Set<string>();
  for (const candidate of undecided) {
    const operationId = candidate.operation.operationId;
    if (approved.has(operationId)) approvedRequestIds.add(operationId);
    else declined.add(operationId);
  }
  return declined;
}

async function recordSilentHistory(
  sourceUrl: string,
  operation: AttemptOperation,
  originKind: 'source' | 'instants'
) {
  try {
    return await sendMessage({
      type: 'RECORD_SILENT_EXPORT',
      sourceUrl,
      originKind,
      item: operation,
    });
  } catch {
    return { error: 'Download started, but history could not be saved.' };
  }
}

async function processCandidate(
  candidate: ReencodeCandidate,
  client: SilentVideoClient,
  sourceUrl: string,
  onProgress: (requestId: string, phase: string, progress: number) => void,
  ownership: OwnershipState,
  approvedOperationIds: ReadonlySet<string>,
  originKind: 'source' | 'instants'
): Promise<DownloadOperationResult> {
  const { operation, preflight } = candidate;
  try {
    onProgress(operation.requestId, 'queued', 0);
    const processed = await client.process(
      operation.operationId,
      operation.requestId,
      !preflight.copyCompatible || approvedOperationIds.has(operation.operationId),
      (phase, progress) => onProgress(operation.requestId, phase, progress)
    );
    if (processed.alreadySilent)
      await client.release(operation.operationId, operation.requestId).catch(() => undefined);
    const url = processed.alreadySilent
      ? operation.url
      : URL.createObjectURL(await readOutput(processed.opfsName!));
    const downloadId = await browser.downloads.download({
      url,
      filename: operation.filename,
      saveAs: false,
    });
    onProgress(operation.requestId, 'downloading', 1);
    const warning = processed.alreadySilent
      ? undefined
      : await trackOwnedDownload(operation, downloadId, url, client, ownership);
    const historyWarning = (await recordSilentHistory(sourceUrl, operation, originKind)).error;
    return DownloadAcceptedResult.make({
      operationId: operation.operationId,
      requestId: operation.requestId,
      status: 'started',
      ...(warning || historyWarning
        ? {
            warning: OperationWarning.make({
              code: warning ? 'SILENT_TEMPORARY_FILE_CLEANUP_UNCONFIRMED' : 'HISTORY_SAVE_FAILED',
            }),
          }
        : {}),
    });
  } catch (cause) {
    return DownloadFailedResult.make({
      operationId: operation.operationId,
      requestId: operation.requestId,
      status: 'failed',
      failure: silentFailure(cause, 'SILENT_UNEXPECTED_FAILURE', 'silent-worker'),
    });
  }
}

async function trackOwnedDownload(
  operation: AttemptOperation,
  downloadId: number,
  url: string,
  client: SilentVideoClient,
  ownership: OwnershipState
): Promise<string | undefined> {
  ownership.activeDownloads++;
  const ownershipReady = transferOutputToDownload(operation.operationId, downloadId);
  releaseWhenComplete(downloadId, url, client, operation, ownershipReady, () => {
    ownership.activeDownloads--;
    if (ownership.batchComplete && ownership.activeDownloads === 0) client.close();
  });
  try {
    await ownershipReady;
    return undefined;
  } catch {
    return 'Download started, but temporary-file ownership could not be recorded.';
  }
}

export async function runSilentVideoBatch(
  operations: readonly AttemptOperation[],
  approveReencode: (candidates: readonly ReencodeCandidate[]) => Promise<ReadonlySet<string>>,
  onProgress: (requestId: string, phase: string, progress: number) => void,
  sourceUrl: string,
  onPreflightComplete: () => void,
  approvedRequestIds: Set<string>,
  originKind: 'source' | 'instants' = 'source'
): Promise<OperationBatchOutcome> {
  const client = new SilentVideoClient();
  const ownership: OwnershipState = { activeDownloads: 0, batchComplete: false };
  for (const operation of operations) onProgress(operation.requestId, 'queued', 0);
  try {
    await sweepOnce();
    const inspected = await inspectOperations(client, operations, onProgress, approvedRequestIds);
    const skipped = await declinedReencodes(
      inspected.candidates,
      approvedRequestIds,
      approveReencode
    );
    onPreflightComplete();
    const results = [...inspected.failures];
    for (const candidate of inspected.candidates) {
      if (skipped.has(candidate.operation.operationId)) {
        await client
          .release(candidate.operation.operationId, candidate.operation.requestId)
          .catch(() => undefined);
      }
      results.push(
        skipped.has(candidate.operation.operationId)
          ? DownloadSkippedResult.make({
              operationId: candidate.operation.operationId,
              requestId: candidate.operation.requestId,
              status: 'skipped',
              code: 'SILENT_REENCODE_DECLINED',
            })
          : await processCandidate(
              candidate,
              client,
              sourceUrl,
              onProgress,
              ownership,
              approvedRequestIds,
              originKind
            )
      );
    }
    return OperationBatchOutcome.make({ outcomes: results });
  } catch (cause) {
    const itemFailure = silentFailure(cause, 'SILENT_STORAGE_UNAVAILABLE', 'silent-storage');
    const failure =
      itemFailure.platform === 'instagram'
        ? OperationFailure.make({
            code: itemFailure.code,
            phase: itemFailure.phase,
            scope: 'batch',
            ...(itemFailure.cause ? { cause: itemFailure.cause } : {}),
          })
        : OperationFailure.make({
            code: 'SILENT_STORAGE_UNAVAILABLE',
            phase: 'silent-storage',
            scope: 'batch',
          });
    return OperationBatchOutcome.make({
      failure,
      outcomes: operations.map(operation =>
        DownloadNotAttemptedResult.make({
          operationId: operation.operationId,
          requestId: operation.requestId,
          status: 'not-attempted',
        })
      ),
    });
  } finally {
    onPreflightComplete();
    ownership.batchComplete = true;
    if (ownership.activeDownloads === 0) client.close();
  }
}

let sweepPromise: Promise<void> | undefined;

function sweepOnce(): Promise<void> {
  return (sweepPromise ??= sweepOutputs());
}

function releaseWhenComplete(
  downloadId: number,
  url: string,
  client: SilentVideoClient,
  operation: AttemptOperation,
  ownershipReady: Promise<void>,
  onReleased: () => void
): void {
  const listener = (delta: { id: number; state?: { current?: string } }) => {
    if (
      delta.id !== downloadId ||
      !['complete', 'interrupted'].includes(delta.state?.current ?? '')
    )
      return;
    browser.downloads.onChanged.removeListener(listener);
    void ownershipReady
      .catch(() => undefined)
      .then(() => {
        URL.revokeObjectURL(url);
        return client.release(operation.operationId, operation.requestId).finally(onReleased);
      });
  };
  browser.downloads.onChanged.addListener(listener);
  void browser.downloads.search({ id: downloadId }).then(items => {
    const state = items[0]?.state;
    if (state === 'complete' || state === 'interrupted')
      listener({ id: downloadId, state: { current: state } });
  });
}
