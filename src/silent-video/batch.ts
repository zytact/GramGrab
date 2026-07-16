import { browser } from '../lib/browser.ts';
import {
  DownloadAcceptedResult,
  DownloadFailedResult,
  DownloadSkippedResult,
  type DownloadOperationResult,
} from '../download/contracts.ts';
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

function errorReason(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message.trim() ? cause.message : fallback;
}

async function inspectOperations(
  client: SilentVideoClient,
  operations: readonly AttemptOperation[],
  onProgress: (requestId: string, phase: string, progress: number) => void
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
        value: await client.inspect(operation.requestId, operation.url, (phase, progress) =>
          onProgress(operation.requestId, phase, progress)
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
          requestId: operation.requestId,
          status: 'failed',
          reason: errorReason(result.reason, 'The source video could not be inspected.'),
        })
      );
  });
  return { candidates, failures };
}

async function declinedReencodes(
  candidates: readonly ReencodeCandidate[],
  approvedRequestIds: Set<string>,
  approveReencode: (candidates: readonly ReencodeCandidate[]) => Promise<boolean>
): Promise<Set<string>> {
  const undecided = candidates.filter(
    candidate =>
      candidate.preflight.audioTrackCount > 0 &&
      !candidate.preflight.copyCompatible &&
      !approvedRequestIds.has(candidate.operation.requestId)
  );
  if (undecided.length === 0) return new Set();
  if (!(await approveReencode(undecided)))
    return new Set(undecided.map(candidate => candidate.operation.requestId));
  for (const candidate of undecided) approvedRequestIds.add(candidate.operation.requestId);
  return new Set();
}

async function recordSilentHistory(sourceUrl: string, operation: AttemptOperation) {
  try {
    return (await browser.runtime.sendMessage({
      type: 'RECORD_SILENT_EXPORT',
      sourceUrl,
      item: operation,
    })) as { error?: string };
  } catch {
    return { error: 'Download started, but history could not be saved.' };
  }
}

async function processCandidate(
  candidate: ReencodeCandidate,
  client: SilentVideoClient,
  sourceUrl: string,
  onProgress: (requestId: string, phase: string, progress: number) => void,
  ownership: OwnershipState
): Promise<DownloadOperationResult> {
  const { operation, preflight } = candidate;
  try {
    onProgress(operation.requestId, 'queued', 0);
    const processed = await client.process(
      operation.requestId,
      !preflight.copyCompatible,
      (phase, progress) => onProgress(operation.requestId, phase, progress)
    );
    if (processed.alreadySilent) await client.release(operation.requestId).catch(() => undefined);
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
    const historyWarning = (await recordSilentHistory(sourceUrl, operation)).error;
    return DownloadAcceptedResult.make({
      requestId: operation.requestId,
      status: 'accepted',
      ...(warning || historyWarning ? { warning: warning ?? historyWarning } : {}),
    });
  } catch (cause) {
    return DownloadFailedResult.make({
      requestId: operation.requestId,
      status: 'failed',
      reason: errorReason(cause, 'Audio removal could not be completed.'),
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
  const ownershipReady = transferOutputToDownload(operation.requestId, downloadId);
  releaseWhenComplete(downloadId, url, client, operation.requestId, ownershipReady, () => {
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
  approveReencode: (candidates: readonly ReencodeCandidate[]) => Promise<boolean>,
  onProgress: (requestId: string, phase: string, progress: number) => void,
  sourceUrl: string,
  onPreflightComplete: () => void,
  approvedRequestIds: Set<string>
): Promise<readonly DownloadOperationResult[]> {
  const client = new SilentVideoClient();
  const ownership: OwnershipState = { activeDownloads: 0, batchComplete: false };
  for (const operation of operations) onProgress(operation.requestId, 'queued', 0);
  try {
    await sweepOnce();
    const inspected = await inspectOperations(client, operations, onProgress);
    const skipped = await declinedReencodes(
      inspected.candidates,
      approvedRequestIds,
      approveReencode
    );
    onPreflightComplete();
    const results = [...inspected.failures];
    for (const candidate of inspected.candidates) {
      if (skipped.has(candidate.operation.requestId)) {
        await client.release(candidate.operation.requestId).catch(() => undefined);
      }
      results.push(
        skipped.has(candidate.operation.requestId)
          ? DownloadSkippedResult.make({
              requestId: candidate.operation.requestId,
              status: 'skipped',
              reason: 'High-quality H.264 re-encoding was declined.',
            })
          : await processCandidate(candidate, client, sourceUrl, onProgress, ownership)
      );
    }
    return results;
  } catch (cause) {
    return operations.map(operation =>
      DownloadFailedResult.make({
        requestId: operation.requestId,
        status: 'failed',
        reason: errorReason(cause, 'Private browser storage is unavailable.'),
      })
    );
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
  requestId: AttemptOperation['requestId'],
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
        return client.release(requestId).finally(onReleased);
      });
  };
  browser.downloads.onChanged.addListener(listener);
  void browser.downloads.search({ id: downloadId }).then(items => {
    const state = items[0]?.state;
    if (state === 'complete' || state === 'interrupted')
      listener({ id: downloadId, state: { current: state } });
  });
}
