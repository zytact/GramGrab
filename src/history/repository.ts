import { browser } from '../lib/browser.ts';
import {
  DOWNLOAD_HISTORY_KEY,
  DOWNLOAD_HISTORY_LIMIT,
  DOWNLOAD_HISTORY_VERSION,
  type DownloadHistoryEntryV1,
  type DownloadHistoryStoreV1,
  type HistoryReadResult,
} from './contracts.ts';
import { historySource } from './source.ts';

let mutationQueue: Promise<void> = Promise.resolve();

const validKinds = new Set(['post', 'reel', 'story', 'highlight', 'profile']);
const validTypes = new Set(['image', 'video']);

function validEntry(value: unknown): value is DownloadHistoryEntryV1 {
  const item = value as Partial<DownloadHistoryEntryV1> | null;
  const source = typeof item?.sourceUrl === 'string' ? historySource(item.sourceUrl) : null;
  return Boolean(
    item &&
    typeof item.id === 'string' &&
    source?.url === item.sourceUrl &&
    source?.kind === item.sourceKind &&
    validKinds.has(item.sourceKind ?? '') &&
    Number.isSafeInteger(item.itemIndex) &&
    item.itemIndex! >= 0 &&
    (!item.mediaId || typeof item.mediaId === 'string') &&
    validTypes.has(item.mediaType ?? '') &&
    typeof item.filenameHint === 'string' &&
    Number.isFinite(item.downloadedAt) &&
    item.outcome === 'accepted'
  );
}

function decode(value: unknown): HistoryReadResult {
  if (value === undefined) return { kind: 'ok', entries: [], repaired: false };
  const store = value as Partial<DownloadHistoryStoreV1> | null;
  if (!store || typeof store.version !== 'number' || !Array.isArray(store.entries))
    return { kind: 'ok', entries: [], repaired: true };
  if (store.version !== DOWNLOAD_HISTORY_VERSION) return { kind: 'unknown-version', entries: [] };
  const entries = store.entries.filter(validEntry);
  return { kind: 'ok', entries, repaired: entries.length !== store.entries.length };
}

async function read(): Promise<HistoryReadResult> {
  return decode((await browser.storage.get(DOWNLOAD_HISTORY_KEY))[DOWNLOAD_HISTORY_KEY]);
}

function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const result = mutationQueue.then(operation, operation);
  mutationQueue = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

export async function getHistory(): Promise<HistoryReadResult> {
  return read();
}

export function appendHistory(entry: DownloadHistoryEntryV1): Promise<DownloadHistoryEntryV1[]> {
  return enqueue(async () => {
    const current = await read();
    if (current.kind === 'unknown-version')
      throw new Error('Download history uses a newer version.');
    const entries = [...current.entries, entry].slice(-DOWNLOAD_HISTORY_LIMIT);
    await browser.storage.set({
      [DOWNLOAD_HISTORY_KEY]: { version: DOWNLOAD_HISTORY_VERSION, entries },
    });
    return entries;
  });
}

export function removeHistory(id: string): Promise<DownloadHistoryEntryV1[]> {
  return enqueue(async () => {
    const current = await read();
    if (current.kind === 'unknown-version')
      throw new Error('Download history uses a newer version.');
    const entries = current.entries.filter(entry => entry.id !== id);
    await browser.storage.set({
      [DOWNLOAD_HISTORY_KEY]: { version: DOWNLOAD_HISTORY_VERSION, entries },
    });
    return entries;
  });
}

export function clearHistory(): Promise<void> {
  return enqueue(async () => {
    const current = await read();
    if (current.kind === 'unknown-version')
      throw new Error('Download history uses a newer version.');
    await browser.storage.set({
      [DOWNLOAD_HISTORY_KEY]: { version: DOWNLOAD_HISTORY_VERSION, entries: [] },
    });
  });
}
