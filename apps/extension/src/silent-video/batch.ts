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
import {
  readInput,
  readOutput,
  sweepOutputs,
  transferInputToDownload,
  transferOutputToDownload,
} from './opfs.ts';
import type { SilentPreflight } from './contracts.ts';

const INSPECTION_CONCURRENCY = 2;

export interface ReencodeCandidate {
  readonly operation: AttemptOperation;
  readonly preflight: SilentPreflight;
}

/** A candidate held back until the person decides whether its re-encode may run. */
interface UndecidedCandidate {
  readonly candidate: ReencodeCandidate;
  readonly index: number;
}

interface OwnershipState {
  activeDownloads: number;
  batchComplete: boolean;
}

/** Which temporary file the browser download reads, and therefore which one it now owns. */
type DownloadArtifact = 'input' | 'output' | 'remote';

interface DownloadSource {
  readonly url: string;
  readonly artifact: DownloadArtifact;
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

/** Processing runs one candidate at a time so a batch never holds more than one output in flight. */
function serialQueue() {
  let tail = Promise.resolve();
  return {
    add(task: () => Promise<void>): void {
      tail = tail.then(task, task);
    },
    drain: () => tail,
  };
}

function needsReencodeDecision(
  candidate: ReencodeCandidate,
  approvedOperationIds: ReadonlySet<string>
): boolean {
  return (
    candidate.preflight.audioTrackCount > 0 &&
    !candidate.preflight.copyCompatible &&
    !approvedOperationIds.has(candidate.operation.operationId)
  );
}

/**
 * Inspects inputs with bounded concurrency and hands every candidate that needs no decision to
 * `onReady` the moment its input lands, so processing overlaps the downloads still running.
 * Candidates that need a re-encode decision are returned instead, because that decision is one
 * prompt covering the whole batch.
 */
async function inspectOperations(
  client: SilentVideoClient,
  operations: readonly AttemptOperation[],
  onProgress: (requestId: string, phase: string, progress: number) => void,
  approvedOperationIds: ReadonlySet<string>,
  onReady: (candidate: ReencodeCandidate, index: number) => void,
  onFailed: (result: DownloadOperationResult, index: number) => void
): Promise<UndecidedCandidate[]> {
  const undecided: UndecidedCandidate[] = [];
  let nextIndex = 0;
  const inspectNext = async (): Promise<void> => {
    const index = nextIndex++;
    const operation = operations[index];
    if (!operation) return;
    try {
      const preflight = await client.inspect(
        operation.operationId,
        operation.requestId,
        operation.url,
        approvedOperationIds.has(operation.operationId),
        (phase, progress) => onProgress(operation.requestId, phase, progress)
      );
      const candidate: ReencodeCandidate = { operation, preflight };
      if (needsReencodeDecision(candidate, approvedOperationIds))
        undecided.push({ candidate, index });
      else onReady(candidate, index);
    } catch (reason) {
      onFailed(
        DownloadFailedResult.make({
          operationId: operation.operationId,
          requestId: operation.requestId,
          status: 'failed',
          failure: silentFailure(reason, 'SILENT_INPUT_INSPECTION_FAILED', 'silent-inspection'),
        }),
        index
      );
    }
    await inspectNext();
  };
  await Promise.all(
    Array.from({ length: Math.min(INSPECTION_CONCURRENCY, operations.length) }, inspectNext)
  );
  return undecided.sort((first, second) => first.index - second.index);
}

async function declinedReencodes(
  undecided: readonly UndecidedCandidate[],
  approvedRequestIds: Set<string>,
  approveReencode: (candidates: readonly ReencodeCandidate[]) => Promise<ReadonlySet<string>>
): Promise<Set<string>> {
  if (undecided.length === 0) return new Set();
  const approved = await approveReencode(undecided.map(pending => pending.candidate));
  const declined = new Set<string>();
  for (const { candidate } of undecided) {
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
    return { warning: 'HISTORY_SAVE_FAILED' as const };
  }
}

/**
 * A video that was already silent is served from the input inspection just downloaded rather than
 * fetched again. If that input can no longer be read, the original remote URL still holds the same
 * bytes, so the download falls back to it and the worker drops its temporary file.
 */
async function resolveDownloadSource(
  processed: { alreadySilent: boolean; opfsName?: string },
  operation: AttemptOperation,
  client: SilentVideoClient
): Promise<DownloadSource> {
  if (!processed.alreadySilent)
    return {
      url: URL.createObjectURL(await readOutput(processed.opfsName!)),
      artifact: 'output',
    };
  try {
    return {
      url: URL.createObjectURL(await readInput(operation.operationId)),
      artifact: 'input',
    };
  } catch {
    await client.release(operation.operationId, operation.requestId).catch(() => undefined);
    return { url: operation.url, artifact: 'remote' };
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
    const source = await resolveDownloadSource(processed, operation, client);
    const downloadId = await browser.downloads.download({
      url: source.url,
      filename: operation.filename,
      saveAs: false,
    });
    onProgress(operation.requestId, 'downloading', 1);
    const warning =
      source.artifact === 'remote'
        ? undefined
        : await trackOwnedDownload(operation, downloadId, source, client, ownership);
    const historyWarning = (await recordSilentHistory(sourceUrl, operation, originKind)).warning;
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
  source: DownloadSource,
  client: SilentVideoClient,
  ownership: OwnershipState
): Promise<string | undefined> {
  ownership.activeDownloads++;
  const ownershipReady =
    source.artifact === 'output'
      ? transferOutputToDownload(operation.operationId, downloadId)
      : transferInputToDownload(operation.operationId, downloadId);
  releaseWhenComplete(downloadId, source.url, client, operation, ownershipReady, () => {
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
    const results = operations.map<DownloadOperationResult | undefined>(() => undefined);
    const queue = serialQueue();
    const enqueueProcessing = (candidate: ReencodeCandidate, index: number) =>
      queue.add(async () => {
        results[index] = await processCandidate(
          candidate,
          client,
          sourceUrl,
          onProgress,
          ownership,
          approvedRequestIds,
          originKind
        );
      });
    const undecided = await inspectOperations(
      client,
      operations,
      onProgress,
      approvedRequestIds,
      enqueueProcessing,
      (result, index) => {
        results[index] = result;
      }
    );
    const declined = await declinedReencodes(undecided, approvedRequestIds, approveReencode);
    onPreflightComplete();
    for (const { candidate, index } of undecided) {
      if (!declined.has(candidate.operation.operationId)) {
        enqueueProcessing(candidate, index);
        continue;
      }
      results[index] = DownloadSkippedResult.make({
        operationId: candidate.operation.operationId,
        requestId: candidate.operation.requestId,
        status: 'skipped',
        code: 'SILENT_REENCODE_DECLINED',
      });
      queue.add(async () => {
        await client
          .release(candidate.operation.operationId, candidate.operation.requestId)
          .catch(() => undefined);
      });
    }
    await queue.drain();
    return OperationBatchOutcome.make({
      outcomes: results.flatMap(result => (result ? [result] : [])),
    });
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
